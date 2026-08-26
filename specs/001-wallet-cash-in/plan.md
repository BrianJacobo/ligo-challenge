# Plan: Wallet Cash-In Service

Traduce [spec.md](./spec.md) a arquitectura técnica concreta.

## Validación global (main.ts)

```ts
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
  }),
);
```

Se usa `ValidationPipe` global (no por-endpoint) porque en un servicio financiero
todos los inputs deben pasar por el mismo nivel de estrictez sin depender de que cada
desarrollador lo recuerde agregar. `whitelist` + `forbidNonWhitelisted` rechazan
cualquier campo no declarado en el DTO (relevante en `CreateCashInDto`, donde no
queremos aceptar campos ocultos que pudieran alterar el monto o el método de pago).
`transform` + `enableImplicitConversion` aseguran que `amount` se valide como
`number` real y no como string, evitando comparaciones/aritmética inconsistente
sobre el monto a cobrar.

## Generación de UUIDs

Se usa `crypto.randomUUID()` (nativo de Node, sin dependencia externa) tanto para
`operationId` como para el token del lock Redis. El paquete `uuid` se probó primero
en la Fase 0 pero se descartó en la Fase 4: su build publicado es ESM-only y Jest
(con `ts-jest` sobre CommonJS) no puede parsearlo (`SyntaxError: Unexpected token
'export'`), lo cual rompía toda la suite de tests e2e. `crypto.randomUUID()` cubre
el mismo caso de uso sin ese problema y sin dependencia adicional.

## Estructura de proyecto

```
src/
  main.ts
  app.module.ts

  cash-in/
    cash-in.module.ts
    cash-in.controller.ts
    cash-in.service.ts
    dto/
      create-cash-in.dto.ts
      cash-in-response.dto.ts
    schemas/
      cash-in-operation.schema.ts
    cash-in-operation.repository.ts

  webhooks/
    webhooks.module.ts
    webhooks.controller.ts
    webhooks.service.ts
    dto/
      payment-webhook.dto.ts

  payment-provider/
    payment-provider.module.ts
    payment-provider.interface.ts
    payment-provider-mock.service.ts

  wallet/
    wallet.module.ts
    wallet.service.ts
    schemas/
      wallet.schema.ts

  idempotency/
    idempotency.module.ts
    idempotency-lock.service.ts   # Redis SET NX PX

  common/
    filters/
    interceptors/
      correlation-id.interceptor.ts
    logger/

test/
  cash-in.e2e-spec.ts
  webhooks.e2e-spec.ts
  idempotency.spec.ts            # unit: concurrencia simulada
```

Se usa un módulo por *bounded context* (cash-in, webhooks, wallet, payment-provider,
idempotency) en vez de por capa técnica — más cercano a DDD, más fácil de defender en
la entrevista dado el stack al que postulas.

## Modelo de datos (MongoDB)

### `cash_in_operations`

```ts
{
  _id: ObjectId,
  operationId: string,          // "op_<uuid>", expuesto al cliente
  idempotencyKey: string,       // UNIQUE INDEX
  userId: string,
  amount: number,                // Decimal128 en producción real; number aquí por simplicidad, documentado
  currency: string,
  paymentMethod: string,
  status: "pending" | "completed" | "failed",
  providerReference: string | null,
  requestHash: string,           // hash del payload, para detectar key reusada con distinto body
  createdAt: Date,
  updatedAt: Date,
}
```

Índices:
- `{ idempotencyKey: 1 }` **unique** → esta es la garantía real de "solo una vez".
- `{ operationId: 1 }` unique.
- `{ userId: 1, createdAt: -1 }` para consultas futuras (no crítico ahora).

**Nota de arranque:** Mongoose construye los índices en background al conectar y
**no** bloquea las escrituras sobre ese modelo mientras tanto. Como el índice único
de `idempotencyKey` es la garantía final anti-doble-cobro, `main.ts` espera
explícitamente `cashInModel.ensureIndexes()` antes de `app.listen()` — un pod nunca
debe aceptar tráfico sin esa protección activa. Esto se detectó como un test flaky
(el índice único a veces "no aplicaba" en la primera escritura de un proceso recién
conectado) y se corrigió tanto en el arranque real como en los tests.

**Nota de aislamiento de tests:** Jest corre cada archivo de test (unit y e2e) como
un worker separado, en paralelo. Si dos archivos apuntan a la misma base de Mongo
(o el mismo Redis DB), el `afterEach`/`afterAll` de uno (`deleteMany`,
`dropDatabase`, `flushdb`) puede borrar datos o índices que otro archivo todavía
necesita a mitad de su ejecución — esto causó fallos intermitentes reales (no
hipotéticos) tanto en los tests unitarios de la Fase 1/3 como en los e2e de la
Fase 4/5. La solución: cada archivo usa su propia base de datos (sufijo por nombre
de archivo en unit tests, por `JEST_WORKER_ID` en e2e vía `test/setup-e2e-env.ts`).

### `wallets`

```ts
{
  _id: ObjectId,
  userId: string,       // unique
  balance: number,       // actualizado solo vía $inc atómico
  updatedAt: Date,
}
```

### `pending_webhooks`

Buffer temporal para webhooks que llegan antes de que exista la operación
correspondiente (ver "Flujo: POST /webhooks/payment", paso 3).

```ts
{
  _id: ObjectId,
  operationId: string,   // UNIQUE INDEX — upsert por reenvíos del mismo webhook
  status: "completed" | "failed",
  providerReference: string | null,
  receivedAt: Date,
}
```

## Máquina de estados

```
        (crear operación)
              │
              ▼
          [pending] ──── provider success (sync o webhook) ───► [completed]
              │
              └───────── provider failed (sync o webhook) ────► [failed]
```

Reglas:
- `pending` es el único estado desde el que se puede transicionar.
- `completed` y `failed` son **terminales**: cualquier evento posterior (webhook
  duplicado, fuera de orden) que intente transicionar desde un estado terminal se
  ignora y se loguea, nunca se sobreescribe.
- La transición se hace con un **update condicional** en Mongo:
  `updateOne({ operationId, status: "pending" }, { $set: { status: newStatus, ... } })`.
  Si `matchedCount === 0`, significa que ya no estaba en `pending` → no-op idempotente.
  Esto resuelve *atómicamente* duplicados y fuera-de-orden sin necesitar un lock aparte.

## Flujo: POST /cash-in

1. Validar DTO y header `Idempotency-Key` (400 si falta o no es UUID).
2. Calcular `requestHash = sha256(userId+amount+currency+paymentMethod)`.
3. Intentar adquirir lock Redis: `SET idempotency:{key} <token> NX PX 10000`.
   - Si **no se adquiere** (otro pod ya está procesando esta key): hacer *polling*
     corto (ej. 3 intentos con backoff de 200ms) leyendo el estado en Mongo; si
     aparece la operación, devolver su resultado; si no aparece tras el timeout,
     devolver `409` con mensaje "operation in progress, retry".
4. Si se adquiere el lock:
   a. Buscar en Mongo por `idempotencyKey`.
      - Si existe y `requestHash` coincide → **liberar lock** y devolver la
        respuesta ya persistida (idempotente), sin llamar al provider de nuevo.
      - Si existe y `requestHash` **no** coincide → liberar lock, devolver `409
        Conflict` (key reusada con payload distinto).
      - Si no existe → continuar.
   b. Insertar documento `status: "pending"` (insert, no upsert — el índice único
      en `idempotencyKey` es la última línea de defensa ante una carrera que el
      lock no cubrió).
      - Si el insert falla por `E11000 duplicate key` (otra instancia ganó la
        carrera entre 4a y 4b): tratar igual que "ya existe", leer y devolver.
   c. Llamar al Payment Provider (mock).
      - **Success** → update condicional a `completed`, `$inc` atómico del balance
        en `wallets`, liberar lock, responder 200.
      - **Failure** explícito → update condicional a `failed`, liberar lock,
        responder con el error correspondiente (no se toca el balance).
      - **Timeout** → la operación queda en `pending` intencionalmente. Se libera
        el lock (para no bloquear reintentos futuros del cliente indefinidamente)
        y se responde algo como `202 Accepted` / `409` documentando que el estado
        es "desconocido, en verificación" — el cliente debe reintentar con el
        **mismo** `Idempotency-Key`, lo cual es seguro por diseño.
5. `finally`: liberar el lock Redis solo si el token coincide (evita liberar un
   lock ajeno si expiró y otro pod ya lo tomó).

## Flujo: POST /webhooks/payment

1. Buscar operación por `operationId`.
   - **No existe todavía** (webhook llegó antes que el insert del paso 4b del flujo
     de cash-in): se guarda el webhook en la colección de buffer `pending_webhooks`
     (`{ operationId, status, providerReference, receivedAt }`, upsert por
     `operationId` para tolerar reenvíos) y se responde `200 OK`. No se lanza
     excepción — es un caso esperado, no un error.
   - **Existe**: aplicar el mismo **update condicional** `status: "pending" →
     newStatus` descrito en la máquina de estados. Si no matchea (ya estaba
     `completed`/`failed`), es un no-op idempotente → responder `200 OK` igual.
2. Si la transición fue efectiva y el nuevo estado es `completed`, ejecutar el
   `$inc` de balance (mismo código que el flujo síncrono, reutilizado — nunca
   acreditar dos veces gracias al update condicional).
3. **Drenado del buffer**: justo después de `insertPending()` en el flujo de
   cash-in (paso 4b), se consulta `pending_webhooks` por ese `operationId`; si hay
   uno bufferizado, se aplica inmediatamente (mismo update condicional) y se borra
   del buffer. Esto cierra la ventana de carrera sin necesitar un job en segundo
   plano ni polling — el propio flujo de cash-in "recoge" el webhook que llegó
   temprano en cuanto la operación existe.

## Concurrencia sobre el saldo (RNF2)

- Nunca leer balance, sumar en memoria, y hacer `save()`.
- Siempre `Wallet.updateOne({ userId }, { $inc: { balance: amount } })`.
- Esto es atómico a nivel de Mongo independientemente de cuántos pods lo llamen
  simultáneamente para operaciones **distintas** del mismo usuario.

## Payment Provider Mock

```ts
interface PaymentProviderResult {
  outcome: "success" | "failure" | "timeout";
  providerReference?: string;
}

interface PaymentProvider {
  charge(input: { amount: number; currency: string; paymentMethod: string }): Promise<PaymentProviderResult>;
}
```

Implementación mock: configurable vía input especial en tests (ej. `paymentMethod:
"card_force_timeout"`, `"card_force_failure"`) para poder escribir tests
determinísticos de cada rama, sin `Math.random` como único mecanismo.

## Observabilidad

- Interceptor global que genera/propaga `correlationId` (usa `Idempotency-Key` si
  está presente, si no genera uno) y lo agrega a un `AsyncLocalStorage` o al logger
  contextual de Nest.
- Todo log dentro de `cash-in.service.ts` y `webhooks.service.ts` incluye
  `operationId` + `correlationId`.

## Manejo de errores (RNF3)

- Fallo de conexión a Mongo al insertar: responder `503`, nunca `200`. El cliente
  debe reintentar (idempotencia garantiza seguridad).
- Fallo de Redis (lock no disponible): degradar a "confiar solo en el índice único
  de Mongo" — se documenta como trade-off aceptado (mayor probabilidad de intentos
  duplicados contra el provider en la ventana de carrera, pero **nunca doble
  acreditación**, porque el update condicional + índice único lo previenen).

## Tests (mapeo a spec)

| Test | Verifica |
|---|---|
| `cash-in.e2e-spec.ts` › happy path | RF1 caso éxito |
| `cash-in.e2e-spec.ts` › mismo key, mismo payload | RF1 idempotencia |
| `cash-in.e2e-spec.ts` › mismo key, distinto payload | RF1 409 |
| `idempotency.spec.ts` › N llamadas concurrentes mismo key | RNF2 concurrencia |
| `cash-in.e2e-spec.ts` › provider timeout | RNF3 resiliencia |
| `webhooks.e2e-spec.ts` › webhook duplicado | RF2 |
| `webhooks.e2e-spec.ts` › webhook fuera de orden | RF2 |
| `webhooks.e2e-spec.ts` › webhook antes que insert | RF2 |

## Fuera de alcance para el plan (decidido, no implementado)

- Reconciliación automática de operaciones `pending` viejas (batch/cron) —
  se documenta en el README como "siguiente paso" recomendado.
- Transacciones multi-documento de Mongo (session/transaction) — se evalúa si el
  tiempo alcanza; si no, se documenta como mejora futura (el update condicional +
  índice único ya cubre los casos de test requeridos sin transacciones explícitas).
