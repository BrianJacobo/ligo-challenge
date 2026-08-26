# Wallet Cash-In Service

Servicio de recarga de saldo (Cash-In) para Ligo, construido en NestJS + TypeScript
como parte del Challenge Técnico Senior Backend. Ver [specs/001-wallet-cash-in](specs/001-wallet-cash-in/)
para la especificación, el plan técnico completo y el desglose de tareas usados
para construir esta solución con un enfoque de spec-driven development.

## Arquitectura

```
APP → API → Cash-In Service ──┬──► Payment Provider (mock in-process)
                               ├──► MongoDB (fuente de verdad)
                               └──► Redis (lock de concurrencia)

POST /cash-in            ──► CashInService
POST /webhooks/payment    ──► WebhooksService
                               │
                               └──► OperationTransitionService (compartido)
                                     └──► WalletService ($inc atómico)
```

Módulos por *bounded context* (no por capa técnica): `cash-in`, `webhooks`,
`wallet`, `payment-provider`, `idempotency`, `common` (observabilidad).

- **`cash-in/`**: endpoint de recarga, máquina de estados de la operación, lock
  de idempotencia.
- **`webhooks/`**: recepción de confirmaciones del proveedor de pago, incluyendo
  el buffer de webhooks que llegan antes de que exista la operación.
- **`wallet/`**: saldo del usuario, actualizado exclusivamente vía `$inc` atómico.
- **`payment-provider/`**: interfaz `PaymentProvider` + mock configurable
  (éxito / fallo / timeout) para poder testear cada rama de forma determinística.
- **`idempotency/`**: lock distribuido sobre Redis.
- **`common/`**: `correlationId` end-to-end vía `AsyncLocalStorage` + logger
  contextual.

## Estrategia de idempotencia

La garantía real de "esta operación se procesa una sola vez" viene del **índice
único de MongoDB** sobre `idempotencyKey` en la colección `cash_in_operations` —
no de una variable en memoria, un `Map`, ni ningún estado que viva dentro de un
solo proceso. Esto es deliberado: el servicio corre en múltiples pods, así que
cualquier mecanismo que no sobreviva a un proceso reiniciado o a otro pod
recibiendo la misma request en paralelo no es una garantía real.

El flujo:

1. Se calcula un hash SHA-256 del payload (`user_id`, `amount`, `currency`,
   `payment_method`).
2. Se intenta un lock corto en Redis (`SET idempotency:{key} NX PX 10000`) —
   esto es una **optimización**, no la garantía: reduce la probabilidad de que
   dos pods lleguen a llamar al proveedor de pago dos veces durante la ventana
   de carrera, pero no es lo que evita el doble cobro.
3. Si la key ya existe en Mongo con el mismo hash → se devuelve la respuesta ya
   persistida, sin tocar el proveedor ni el saldo de nuevo.
4. Si la key ya existe con un hash distinto → `409 Conflict` (la key se está
   reusando para una operación distinta, lo cual está prohibido).
5. Si no existe, se inserta un documento en estado `pending`. Si ese insert
   falla por `E11000 duplicate key` (otro pod ganó una carrera que el lock de
   Redis no alcanzó a cubrir), se relee y se trata como si ya existiera.

**Por qué Mongo y no solo Redis:** Redis puede perder datos ante un fallo (según
la política de persistencia) y no tiene por diseño la semántica de "constraint"
que sí tiene un índice único relacional/documental. Mongo es la fuente de verdad
duradera; Redis acelera el caso común sin ser un punto único de fallo para la
garantía de negocio.

**Nota de arranque importante:** Mongoose construye los índices en background al
conectar y **no bloquea** las escrituras mientras tanto. Esto significa que un
pod recién arrancado podría, en teoría, aceptar una escritura antes de que el
índice único exista. Por eso `main.ts` espera explícitamente
`cashInModel.ensureIndexes()` antes de `app.listen()` — ver la sección "Qué tuve
que corregir yo mismo" más abajo, este fue un bug real, no una decisión de
diseño anticipada.

## Manejo de concurrencia

Dos problemas de concurrencia distintos, dos soluciones distintas:

1. **Misma `Idempotency-Key` en paralelo** (ej. doble click, retry automático
   solapado con la request original, múltiples pods recibiendo la misma request
   reenviada): resuelto por el lock de Redis + el índice único de Mongo como
   respaldo, descrito arriba.
2. **Actualización del saldo de un mismo usuario desde operaciones legítimas y
   distintas** (race condition sobre el saldo): `WalletService.creditBalance()`
   usa exclusivamente `findOneAndUpdate` con `$inc`, nunca un patrón
   lectura-modificación-escritura en código de aplicación. `$inc` es atómico a
   nivel de MongoDB sin importar cuántos pods lo invoquen al mismo tiempo — se
   verifica con un test que dispara 10 créditos concurrentes al mismo wallet y
   confirma que el balance final es la suma exacta, no un valor menor por
   updates perdidos.

## Estrategia de retry

Gracias a la idempotencia real, **es seguro que el cliente reintente cualquier
request con el mismo `Idempotency-Key`**, incluyendo tras un timeout de red del
lado del cliente. El servicio nunca deja que un reintento cause un segundo cobro
o un segundo crédito de saldo.

Frente a un timeout del **proveedor de pago** (no del cliente), la operación
queda deliberadamente en estado `pending` — el servicio no asume éxito ni fallo,
porque no lo sabe. La respuesta HTTP es `200` con `status: "pending"` y un
mensaje explícito indicando que el resultado se confirmará más adelante (vía
webhook) y que el cliente puede reintentar con el mismo `Idempotency-Key` sin
riesgo.

Lo que el servicio **nunca** hace: reintentar automáticamente contra el
proveedor de pago por su cuenta ante un timeout. Eso multiplicaría el riesgo de
cobro duplicado del lado del proveedor externo, que es exactamente lo que la
idempotencia de este servicio no puede controlar (esa parte depende del
proveedor real, fuera de este alcance).

## Manejo de webhooks

- **Duplicado**: la transición de estado es un `findOneAndUpdate` condicional
  (`{ operationId, status: "pending" }`). Si la operación ya no está en
  `pending` (porque el primer webhook ya la resolvió), el update no matchea,
  no pasa nada, y se responde `200` igual — sin re-acreditar el saldo.
- **Fuera de orden** (ej. un `failed` que llega después de que un `success` ya
  se aplicó): mismo mecanismo — `completed` y `failed` son estados terminales,
  ningún evento posterior puede sobreescribirlos.
- **Llega antes de que exista la operación** (el insert síncrono de
  `POST /cash-in` todavía no terminó): en vez de solo loguear y descartar el
  webhook, se guarda en una colección buffer (`pending_webhooks`, con upsert por
  `operationId` para tolerar reenvíos). `CashInService` revisa ese buffer justo
  después de insertar la operación y, si encuentra un webhook esperando, lo
  aplica de inmediato — sin necesitar un job en background ni polling. Si el
  webhook ya trajo el resultado final, el proveedor de pago **ni siquiera se
  llama**: ya no hace falta.

## Observabilidad

Cada request obtiene un `correlationId` (prioridad: header `X-Correlation-Id` →
`Idempotency-Key` → uno generado) propagado vía `AsyncLocalStorage` y visible en
todos los logs relacionados a esa operación — inicio del proceso, resultado del
proveedor, cada transición de estado, y recepción de cada webhook — sin tener
que pasarlo manualmente entre funciones. También se devuelve en la respuesta
como header `X-Correlation-Id`.

## Setup y ejecución

Requisitos: Node.js 22+, Docker (para Mongo y Redis).

```bash
# 1. Levantar MongoDB y Redis
docker compose up -d

# 2. Instalar dependencias
npm install

# 3. Copiar variables de entorno
cp .env.example .env

# 4. Correr en modo desarrollo
npm run start:dev

# 5. Correr tests
npm test           # unit
npm run test:e2e   # end-to-end
```

### Probar manualmente

```bash
curl -X POST http://localhost:3000/cash-in \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(node -e 'console.log(crypto.randomUUID())')" \
  -d '{"user_id":"usr_abc123","amount":100,"currency":"PEN","payment_method":"card_xyz"}'
```

Métodos de pago especiales del mock para forzar cada rama:
- `payment_method: "card_force_timeout"` → simula timeout del proveedor.
- `payment_method: "card_force_failure"` → simula fallo explícito del proveedor.
- Cualquier otro valor → éxito.

## Uso del agente de IA

Esta solución se construyó con Claude Code siguiendo un flujo de **spec-driven
development**: primero se armó `specs/001-wallet-cash-in/spec.md` (requisitos y
criterios de aceptación) y `plan.md` (arquitectura técnica y decisiones de
diseño) en conversación conmigo, y luego se implementó fase por fase siguiendo
`tasks.md`, revisando cada resultado antes de avanzar a la siguiente fase.

**Decisiones que tomé yo, no el agente**, resueltas antes de escribir código:

- Stack (NestJS + MongoDB + Redis) — elegido por alineación con la posición a la
  que postulo, no sugerido por el agente.
- Mongo como fuente de verdad de idempotencia y Redis como optimización de
  concurrencia (no al revés, y no solo Redis).
- Mock in-process del proveedor de pago en vez de un servicio HTTP separado, para
  priorizar tests determinísticos dado el límite de 3-4 horas.
- Buffer real en Mongo para webhooks tempranos en vez de la alternativa más
  simple de solo loguear y descartar — se evaluó el trade-off explícitamente
  antes de implementar.

**Qué generó bien el agente, sin necesitar corrección:** el scaffolding de
NestJS, los esquemas de Mongoose, la estructura de módulos por bounded context,
los DTOs con `class-validator`, y la implementación inicial de la máquina de
estados con `findOneAndUpdate` condicional (la pieza más importante de todo el
diseño de idempotencia) fueron correctos desde el primer intento porque la spec
y el plan ya habían dejado esa decisión completamente especificada de antemano.

**Qué tuve que corregir yo mismo** (bugs reales encontrados durante el
desarrollo, no hipotéticos — cada uno detectado por un test que falló):

1. **Dependencia `uuid` incompatible con el entorno de test.** El agente la
   agregó en el bootstrap inicial (Fase 0) porque es la opción más común para
   generar UUIDs en Node. Al implementar el endpoint (Fase 4), el build de Jest
   se rompió: `uuid@14` publica solo un build ESM, incompatible con
   `ts-jest`/CommonJS. Se corrigió reemplazándolo por `crypto.randomUUID()`
   nativo de Node, que no tiene ese problema y elimina una dependencia.

2. **Índice único de Mongo no garantizado al arrancar.** Mongoose construye los
   índices en background al conectar y no bloquea las escrituras mientras
   tanto. Esto significa que, sin corrección, un pod recién arrancado podría
   aceptar temporalmente escrituras **sin** la protección del índice único de
   `idempotencyKey` — justo la garantía central de todo el diseño de
   idempotencia. Se detectó como un test intermitente (a veces el índice único
   "no aplicaba" en el primer insert de un proceso recién conectado) y se
   corrigió esperando explícitamente `ensureIndexes()` antes de `app.listen()`,
   tanto en producción como en los tests.

3. **Aislamiento de tests entre archivos.** Los primeros tests escritos (Fase 1)
   compartían la misma base de datos de Mongo (y luego, en Fase 4/5, el mismo
   Redis) entre distintos archivos `.spec.ts`/`.e2e-spec.ts`. Como Jest corre
   cada archivo como un worker en paralelo, el `afterAll`/`afterEach` de un
   archivo (`dropDatabase`, `deleteMany`, `flushdb`) podía borrar datos o
   índices que otro archivo todavía necesitaba a mitad de su ejecución. Esto
   causó fallos intermitentes reales, no un problema teórico — se manifestó dos
   veces, primero en unit tests y después en e2e. Se corrigió dando a cada
   archivo (o cada worker de Jest, vía `JEST_WORKER_ID`) su propia base de
   datos y su propio Redis DB lógico.

4. **Duplicación entre el bootstrap real y el helper de tests e2e.** El
   `ValidationPipe` y la espera de `ensureIndexes()` se habían escrito primero
   en `main.ts`, y luego se copiaron manualmente al helper de tests e2e. Al
   agregar el interceptor de `correlationId` en la Fase 6, actualicé `main.ts`
   pero inicialmente no el helper — los tests e2e no mostraban el
   `correlationId` en los logs, aunque el código de producción sí lo hacía
   correctamente. Se corrigió extrayendo la configuración compartida a
   `src/bootstrap.ts`, usado por ambos, para que este tipo de desincronización
   no pueda volver a pasar silenciosamente.

5. **El plan documentaba manejo de errores que el código no implementaba.**
   `plan.md` decía desde la Fase 1 "fallo de Mongo → 503" y "fallo de Redis →
   degradar a solo-Mongo", pero al escribir el código de `CashInService` esas
   dos ramas nunca se implementaron: un fallo real de Mongo se propagaba como
   `500` genérico, y un fallo de Redis en `acquire()` tumbaba toda la request
   en vez de continuar sin lock. Esto no lo detectó ningún test hasta la
   revisión final (Fase 9), al repasar los 10 escenarios del challenge uno por
   uno contra el código real — "fallo temporal de DB" no tenía ni código ni
   test que lo cubriera. Se corrigió distinguiendo `DuplicateIdempotencyKeyError`
   (esperado) de cualquier otro error de Mongo (`ServiceUnavailableException`),
   y envolviendo `lockService.acquire()` en un try/catch que degrada a confiar
   solo en el índice único si Redis no responde.

**Por qué esto importa:** los puntos 2, 3 y 5 son exactamente el tipo de detalle
que un agente de IA (o un desarrollador apurado) puede pasar por alto porque el
código "se ve correcto" — compila, y hasta puede pasar tests si estos no se
ejecutan bajo las condiciones reales (multi-pod, tests en paralelo, infraestructura
caída) que los exponen. El punto 5 en particular es una lección sobre spec-driven
development: escribir la decisión en el plan no significa que el código la
cumple — hay que verificarlo contra la implementación real, no solo contra la
documentación. Encontrarlos requirió correr la suite de tests repetidamente y
desconfiar de un resultado "verde" la primera vez, no solo leer el código.
