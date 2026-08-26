# Tasks: Wallet Cash-In Service

Deriva de [spec.md](./spec.md) y [plan.md](./plan.md). Marcar cada tarea al completarla.
Orden pensado para tener siempre algo ejecutable (no bloquear tests hasta el final).

## Fase 0 — Bootstrap

- [x] T0.1: Inicializar proyecto NestJS (`nest new`) con TypeScript strict mode.
- [x] T0.2: Agregar dependencias: `@nestjs/mongoose`, `mongoose`, `ioredis`,
      `class-validator`, `class-transformer`, `uuid`.
- [x] T0.3: `docker-compose.yml` con MongoDB y Redis para desarrollo/tests locales.
- [x] T0.4: Configurar `ConfigModule` (env vars: `MONGO_URI`, `REDIS_URL`, `PORT`).
- [x] T0.4b: Configurar `app.useGlobalPipes(new ValidationPipe({ whitelist: true,
      forbidNonWhitelisted: true, transform: true, transformOptions: {
      enableImplicitConversion: true } }))` en `main.ts` (ver plan.md).
- [x] T0.5: Configurar Jest para unit + e2e (`test/jest-e2e.json`).

## Fase 1 — Modelos y persistencia

- [ ] T1.1: Crear `CashInOperationSchema` (Mongoose) según plan.md, con índice único
      en `idempotencyKey` y en `operationId`.
- [ ] T1.2: Crear `WalletSchema` con índice único en `userId`.
- [ ] T1.3: Crear `CashInOperationRepository` con métodos: `findByIdempotencyKey`,
      `insertPending`, `updateStatusIfPending` (update condicional descrito en plan.md),
      `findByOperationId`.
- [ ] T1.4: Crear `WalletService.creditBalance(userId, amount)` usando `$inc` atómico
      (con `upsert: true` para crear wallet si no existe, balance inicial 0).
- [ ] T1.5: Seed script o fixture de test para crear un wallet con balance inicial
      conocido (ej. 250.00) para pruebas manuales/e2e.

## Fase 2 — Payment Provider Mock

- [ ] T2.1: Definir interfaz `PaymentProvider` (plan.md).
- [ ] T2.2: Implementar `PaymentProviderMockService`:
      - `paymentMethod` normal → `success` tras latencia simulada corta (ej. 50-200ms).
      - `paymentMethod === "card_force_timeout"` → lanza timeout tras N ms.
      - `paymentMethod === "card_force_failure"` → retorna `failure` inmediato.
- [ ] T2.3: Unit test de `PaymentProviderMockService` (los 3 outcomes se disparan
      correctamente según input).

## Fase 3 — Idempotencia y lock

- [ ] T3.1: Implementar `IdempotencyLockService` sobre `ioredis`:
      `acquire(key, ttlMs)` → `SET key token NX PX ttlMs`, `release(key, token)` →
      script Lua o check-then-del para no borrar lock ajeno.
- [ ] T3.2: Unit test: dos `acquire` concurrentes con la misma key → solo uno
      retorna éxito.
- [ ] T3.3: Unit test: `release` con token incorrecto no borra el lock.

## Fase 4 — POST /cash-in

- [ ] T4.1: `CreateCashInDto` con validación (`class-validator`): `user_id`
      (`@IsString()`), `amount` (`@IsNumber()` + `@IsPositive()`), `currency`
      (`@IsString()`), `payment_method` (`@IsString()`). Sin `@IsOptional()` en
      ninguno — todos son requeridos; cualquier campo extra será rechazado por el
      `ValidationPipe` global (`forbidNonWhitelisted`).
- [ ] T4.2: Validar header `Idempotency-Key` (formato UUID) en el controller o un
      guard/pipe dedicado → 400 si falta o inválido.
- [ ] T4.3: Implementar `CashInService.process()` siguiendo el flujo completo de
      plan.md (lock → check existente por hash → insert pending → llamar provider →
      transición de estado → crédito de balance → liberar lock).
- [ ] T4.4: Manejar rama "key existe, mismo hash" → responder con datos persistidos,
      sin tocar provider ni balance.
- [ ] T4.5: Manejar rama "key existe, distinto hash" → `409 Conflict`.
- [ ] T4.6: Manejar rama "insert falla por duplicate key" (carrera no cubierta por
      el lock) → releer y responder como si ya existiera.
- [ ] T4.7: Manejar rama timeout del provider → dejar `pending`, responder estado
      explícito de "en verificación" (documentar código HTTP elegido).
- [ ] T4.8: Manejar rama failure del provider → transición a `failed`, responder
      error sin tocar balance.
- [ ] T4.9: Mapear `CashInOperation` → `CashInResponseDto` (`operation_id`, `status`,
      `amount`, `new_balance`).

## Fase 5 — POST /webhooks/payment

- [ ] T5.1: `PaymentWebhookDto` con validación.
- [ ] T5.2: Implementar `WebhooksService.handlePaymentWebhook()`:
      - Operación no encontrada → estrategia definida en plan.md (buffer o log +
        200), documentar la elección en el README.
      - Operación encontrada → `updateStatusIfPending`; si no matchea (ya terminal),
        no-op idempotente, responder 200.
      - Si transición efectiva a `completed` → acreditar balance (reusar
        `WalletService.creditBalance`).
- [ ] T5.3: Verificar explícitamente que un webhook `failed` no puede sobreescribir
      un estado `completed` ya alcanzado (y viceversa).

## Fase 6 — Observabilidad

- [ ] T6.1: Interceptor/middleware que genera o propaga `correlationId` (usa
      `Idempotency-Key` si existe) y lo inyecta en el logger contextual de cada
      request.
- [ ] T6.2: Agregar logs con `operationId` + `correlationId` en los puntos clave:
      inicio de proceso, resultado del provider, transición de estado, webhook recibido.

## Fase 7 — Tests (mínimos obligatorios del challenge)

- [ ] T7.1: E2E — Happy path: `POST /cash-in` exitoso, balance actualizado
      correctamente.
- [ ] T7.2: E2E — Mismo `Idempotency-Key` + mismo payload reintentado → misma
      respuesta exacta, provider llamado una sola vez (verificar con spy/mock call count).
- [ ] T7.3: E2E — Mismo `Idempotency-Key` + payload distinto → `409`.
- [ ] T7.4: Unit/integración — N (ej. 10) requests concurrentes con la misma
      `Idempotency-Key` → exactamente 1 llamada real al provider, todas las respuestas
      consistentes entre sí.
- [ ] T7.5: E2E — `payment_method: "card_force_timeout"` → operación queda `pending`,
      balance no se altera.
- [ ] T7.6: E2E — Webhook duplicado (enviar el mismo payload de webhook 2 veces) →
      balance acreditado una sola vez.
- [ ] T7.7: E2E — Webhook fuera de orden (`failed` enviado después de que la
      operación ya está `completed`) → estado permanece `completed`.
- [ ] T7.8: E2E — Webhook llega para un `operationId` que aún no existe en Mongo →
      no lanza excepción no controlada, comportamiento documentado se cumple.
- [ ] T7.9: Correr `npm test` y `npm run test:e2e` limpio (sin tests skip, sin
      console.error de errores no esperados).

## Fase 8 — README

- [ ] T8.1: Sección "Arquitectura" con diagrama simple (puede ser ASCII, igual al de
      plan.md).
- [ ] T8.2: Sección "Estrategia de idempotencia" — explicar por qué Mongo (índice
      único) es la fuente de verdad y Redis es optimización, no garantía.
- [ ] T8.3: Sección "Manejo de concurrencia" — lock Redis + `$inc` atómico de balance.
- [ ] T8.4: Sección "Estrategia de retry" — qué es seguro reintentar (todo, gracias a
      idempotencia) y qué código/mensaje debe usar el cliente ante timeout.
- [ ] T8.5: Sección "Manejo de webhooks" — duplicados, fuera de orden, llegada
      temprana; incluir la limitación documentada de T5.2 si no se implementó buffer
      completo.
- [ ] T8.6: **Sección obligatoria "Uso del agente de IA"** — qué prompts/specs se
      dieron (referenciar este mismo spec.md/plan.md), qué generó el agente
      correctamente, y qué se tuvo que corregir manualmente (ser específico: ej.
      "el agente propuso idempotencia solo con una Map en memoria, se corrigió a
      índice único de Mongo + lock Redis porque no sobrevive a multi-pod").
- [ ] T8.7: Instrucciones de setup y ejecución (`docker-compose up`, `npm install`,
      `npm run start:dev`, `npm test`).

## Fase 9 — Revisión final

- [ ] T9.1: Repasar los 10 escenarios del challenge original uno por uno y confirmar
      que cada uno está cubierto por código y/o test (o documentado como limitación
      consciente).
- [ ] T9.2: Revisar que ningún "red flag" de la rúbrica aplique a la solución final
      (idempotencia en memoria, ignorar multi-pod, retry indiscriminado, confiar en
      webhook único, sin tests).
- [ ] T9.3: Limpiar código generado por el agente que no se usa, TODOs olvidados,
      logs de debug.
