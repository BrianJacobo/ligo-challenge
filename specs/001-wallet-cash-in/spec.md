# Spec: Wallet Cash-In Service

## Contexto

Ligo Tech (equipo B2C) necesita un servicio de recarga de saldo (Cash-In) que se comunica
con una pasarela de pagos externa. El flujo es:

```
APP → API → Cash-In Service → Payment Provider
                            ↓
                     Wallet / Ledger (DB)
```

El servicio corre en múltiples pods (Kubernetes). El proveedor de pagos puede fallar,
tardar (timeout) o confirmar la operación vía webhook de forma asíncrona, duplicada o
fuera de orden.

**Problema central a resolver:** el proveedor cobra S/100. Antes de que responda, ocurre
un timeout. El cliente no sabe si el cobro se realizó y reintenta. El servicio no debe
cobrar dos veces.

## Out of scope

- Integración real con un proveedor de pagos (se simula con un mock in-process).
- Autenticación/autorización de usuarios (se asume que la API gateway ya validó al caller).
- Cash-Out, transferencias entre wallets, u otras operaciones de wallet.
- UI o app cliente.
- Despliegue a infraestructura real (Kubernetes, Terraform, etc.) — solo se diseña
  asumiendo un entorno multi-pod, no se despliega.

## Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: NestJS
- **Persistencia (fuente de verdad)**: MongoDB — colección `cash_in_operations` con
  índice único en `idempotencyKey`
- **Concurrencia (lock distribuido de corta duración)**: Redis (`SET NX PX`)
- **Payment Provider**: mock in-process configurable (éxito / timeout / fallo)
- **Tests**: Jest

## Requisitos funcionales

### RF1 — POST /cash-in

Request:
```json
{
  "user_id": "usr_abc123",
  "amount": 100.00,
  "currency": "PEN",
  "payment_method": "card_xyz"
}
```
Header requerido: `Idempotency-Key: <UUID>`

Response 200:
```json
{
  "operation_id": "op_9f8e7d",
  "status": "completed",
  "amount": 100.00,
  "new_balance": 350.00
}
```

Criterios de aceptación:
- Dado un `Idempotency-Key` nuevo, cuando se llama a `/cash-in`, entonces se crea una
  operación, se llama al Payment Provider, y se retorna el resultado.
- Dado un `Idempotency-Key` ya usado con el mismo payload, cuando se reintenta,
  entonces se retorna la **misma respuesta** que la primera vez, sin volver a llamar
  al Payment Provider ni afectar el saldo de nuevo.
- Dado un `Idempotency-Key` ya usado pero con un payload **distinto** (ej. distinto
  `amount`), entonces se retorna `409 Conflict` (la key no puede reutilizarse para
  una operación diferente).
- Dado que dos requests con el mismo `Idempotency-Key` llegan simultáneamente a pods
  distintos, entonces solo una consigue procesar la operación contra el Payment
  Provider; la otra espera o recibe el resultado de la primera.
- Dado que falta el header `Idempotency-Key`, entonces se retorna `400 Bad Request`.

### RF2 — POST /webhooks/payment

Request (simulado, enviado por el Payment Provider mock):
```json
{
  "operation_id": "op_9f8e7d",
  "provider_reference": "prov_xyz",
  "status": "success" | "failed",
  "timestamp": "2026-08-26T10:00:00Z"
}
```

Criterios de aceptación:
- Dado un webhook para una operación en estado `pending`, cuando llega con
  `status: success`, entonces la operación pasa a `completed` y se acredita el saldo
  (si no fue acreditado ya por la respuesta síncrona).
- Dado un webhook **duplicado** (mismo `operation_id` + mismo `status`, ya procesado),
  entonces se ignora sin efectos secundarios y se responde `200 OK`.
- Dado un webhook que llega **fuera de orden** (ej. `failed` después de que ya se
  procesó `success`, o un webhook viejo reenviado), entonces no se sobreescribe un
  estado terminal ya alcanzado.
- Dado un webhook que llega **antes** de que la llamada síncrona al Payment Provider
  haya retornado (la operación aún no existe o está en un estado transitorio),
  entonces el webhook queda registrado/aplicado de forma consistente una vez que la
  operación exista (no se pierde ni se duplica el efecto).
- Dado un `operation_id` desconocido, entonces se responde `404` (o `200` idempotente,
  a decidir y documentar) sin crear estado inconsistente.

### RF3 — Máquina de estados de la operación

Estados mínimos: `pending → completed | failed`. Debe documentarse explícitamente
en el README qué transiciones son válidas y cuáles se ignoran (ver RNF2).

## Requisitos no funcionales

### RNF1 — Idempotencia real (multi-pod)

- La idempotencia **no puede** depender de estado en memoria de un solo proceso.
- Debe sobrevivir a reinicios del servicio y a múltiples pods corriendo en paralelo.
- Mongo (índice único en `idempotencyKey`) es la fuente de verdad; Redis es una
  optimización de lock para reducir trabajo duplicado en la ventana de carrera, no
  la garantía final.

### RNF2 — Concurrencia

- Debe explicarse y probarse el caso: N requests concurrentes con la misma
  `Idempotency-Key` → exactamente una ejecuta la lógica de negocio contra el
  Payment Provider.
- Debe explicarse y probarse el caso de **race condition sobre el saldo**: dos
  operaciones distintas y legítimas del mismo usuario que intentan actualizar el
  balance al mismo tiempo no deben pisarse (usar operación atómica de Mongo tipo
  `$inc`, no read-modify-write en la aplicación).

### RNF3 — Resiliencia / manejo de errores

- Timeout del Payment Provider: la operación debe quedar en un estado explícito
  (ej. `pending` / `provider_unknown`) — nunca asumir éxito ni fallo. Debe existir
  un mecanismo (webhook posterior o reconciliación) para resolverla.
- Fallo temporal de DB: debe fallar de forma segura (no reportar éxito si no se
  pudo persistir) y ser explícito sobre si el request es reintentable por el cliente.
- Reinicio del servicio a mitad de una operación: al reiniciar, ninguna operación
  debe quedar en un estado que permita doble-procesamiento; el estado persistido en
  Mongo/Redis debe ser suficiente para retomar o rechazar con seguridad.
- Retry automático de la app cliente: debe ser seguro por diseño (idempotencia),
  nunca mitigado con "no reintentar" como única defensa.

### RNF4 — Persistencia y modelado de datos

- Modelo de operación (`cash_in_operations`) debe incluir al menos: `operationId`,
  `idempotencyKey` (único), `userId`, `amount`, `currency`, `status`, `providerReference`,
  `createdAt`, `updatedAt`.
- Actualizaciones de saldo deben ser atómicas (`findOneAndUpdate` con `$inc`, o
  transacción Mongo si aplica).

### RNF5 — Observabilidad

- Cada operación debe propagar un `correlationId`/`traceId` (puede ser el mismo
  `operation_id` o uno generado por request) presente en todos los logs relacionados
  a esa operación, incluyendo el webhook que la resuelve.

## Escenarios que deben tener test

1. Cash-in exitoso (happy path).
2. Mismo `Idempotency-Key` reintentado → misma respuesta, sin doble cobro.
3. Mismo `Idempotency-Key`, payload distinto → `409 Conflict`.
4. N requests concurrentes con la misma `Idempotency-Key` → una sola ejecución real
   contra el Payment Provider.
5. Timeout del Payment Provider → operación queda en estado no-terminal explícito,
   no se acredita saldo.
6. Webhook duplicado → sin efectos secundarios, respuesta 200.
7. Webhook fuera de orden → no sobreescribe estado terminal.
8. Webhook llega antes que la respuesta síncrona del API → se resuelve sin perder
   ni duplicar el efecto.

## Entregables

- Código fuente (NestJS) con `POST /cash-in` y `POST /webhooks/payment`.
- Tests automatizados (Jest) cubriendo los escenarios de la sección anterior.
- `README.md` con:
  - Arquitectura propuesta (diagrama simple).
  - Estrategia de idempotencia (por qué Mongo + Redis, no memoria).
  - Manejo de concurrencia (lock distribuido, `$inc` atómico).
  - Estrategia de retry (qué es seguro reintentar y qué no).
  - Manejo de webhooks (duplicados, fuera de orden, llegada temprana).
  - **Sección obligatoria: uso del agente de IA** — qué specs/prompts se le dieron,
    qué generó, y qué tuvo que corregirse o rediseñarse manualmente y por qué.

## Decisiones abiertas para la implementación

Estas decisiones se toman y documentan durante el desarrollo, no son parte fija de
esta spec:

- Formato exacto del lock Redis (TTL, clave) y qué pasa si Redis no está disponible
  (¿se degrada a solo-Mongo o se rechaza el request?).
- Código de respuesta exacto para webhook con `operation_id` desconocido (404 vs 200).
- Si la acreditación del saldo ocurre en la respuesta síncrona, en el webhook, o en
  ambos casos de forma idempotente (recomendado: idempotente en ambos, gana el primero
  que llegue).
