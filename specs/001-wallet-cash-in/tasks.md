# Tasks: Wallet Cash-In Service

Deriva de [spec.md](./spec.md) y [plan.md](./plan.md). Marcar cada tarea al completarla.
Orden pensado para tener siempre algo ejecutable (no bloquear tests hasta el final).

## Fase 0 — Bootstrap

- [x] T0.1: Inicializar proyecto NestJS (`nest new`) con TypeScript strict mode.
- [x] T0.2: Agregar dependencias: `@nestjs/mongoose`, `mongoose`, `ioredis`,
      `class-validator`, `class-transformer`. (El paquete `uuid` se probó y se
      quitó en la Fase 4: su build es ESM-only y rompía Jest bajo `ts-jest`/
      CommonJS; se usa `crypto.randomUUID()` nativo de Node en su lugar.)
- [x] T0.3: `docker-compose.yml` con MongoDB y Redis para desarrollo/tests locales.
- [x] T0.4: Configurar `ConfigModule` (env vars: `MONGO_URI`, `REDIS_URL`, `PORT`).
- [x] T0.4b: Configurar `app.useGlobalPipes(new ValidationPipe({ whitelist: true,
      forbidNonWhitelisted: true, transform: true, transformOptions: {
      enableImplicitConversion: true } }))` en `main.ts` (ver plan.md).
- [x] T0.5: Configurar Jest para unit + e2e (`test/jest-e2e.json`).

## Fase 1 — Modelos y persistencia

- [x] T1.1: Crear `CashInOperationSchema` (Mongoose) según plan.md, con índice único
      en `idempotencyKey` y en `operationId`.
- [x] T1.2: Crear `WalletSchema` con índice único en `userId`.
- [x] T1.3: Crear `CashInOperationRepository` con métodos: `findByIdempotencyKey`,
      `insertPending`, `updateStatusIfPending` (update condicional descrito en plan.md),
      `findByOperationId`.
- [x] T1.4: Crear `WalletService.creditBalance(userId, amount)` usando `$inc` atómico
      (con `upsert: true` para crear wallet si no existe, balance inicial 0).
- [x] T1.5: Seed script o fixture de test para crear un wallet con balance inicial
      conocido (ej. 250.00) para pruebas manuales/e2e.

## Fase 2 — Payment Provider Mock

- [x] T2.1: Definir interfaz `PaymentProvider` (plan.md).
- [x] T2.2: Implementar `PaymentProviderMockService`:
      - `paymentMethod` normal → `success` tras latencia simulada corta (ej. 50-200ms).
      - `paymentMethod === "card_force_timeout"` → lanza timeout tras N ms.
      - `paymentMethod === "card_force_failure"` → retorna `failure` inmediato.
- [x] T2.3: Unit test de `PaymentProviderMockService` (los 3 outcomes se disparan
      correctamente según input).

## Fase 3 — Idempotencia y lock

- [x] T3.1: Implementar `IdempotencyLockService` sobre `ioredis`:
      `acquire(key, ttlMs)` → `SET key token NX PX ttlMs`, `release(key, token)` →
      script Lua o check-then-del para no borrar lock ajeno.
- [x] T3.2: Unit test: dos `acquire` concurrentes con la misma key → solo uno
      retorna éxito.
- [x] T3.3: Unit test: `release` con token incorrecto no borra el lock.

## Fase 4 — POST /cash-in

- [x] T4.1: `CreateCashInDto` con validación (`class-validator`): `user_id`
      (`@IsString()`), `amount` (`@IsNumber()` + `@IsPositive()`), `currency`
      (`@IsString()`), `payment_method` (`@IsString()`). Sin `@IsOptional()` en
      ninguno — todos son requeridos; cualquier campo extra será rechazado por el
      `ValidationPipe` global (`forbidNonWhitelisted`).
- [x] T4.2: Validar header `Idempotency-Key` (formato UUID) en el controller o un
      guard/pipe dedicado → 400 si falta o inválido. (`IdempotencyKeyPipe`, aplicado
      manualmente en el controller porque `@Headers()` no soporta pipes vía decorador
      como sí lo hacen `@Param`/`@Query`/`@Body`.)
- [x] T4.3: Implementar `CashInService.process()` siguiendo el flujo completo de
      plan.md (lock → check existente por hash → insert pending → llamar provider →
      transición de estado → crédito de balance → liberar lock).
- [x] T4.4: Manejar rama "key existe, mismo hash" → responder con datos persistidos,
      sin tocar provider ni balance.
- [x] T4.5: Manejar rama "key existe, distinto hash" → `409 Conflict`.
- [x] T4.6: Manejar rama "insert falla por duplicate key" (carrera no cubierta por
      el lock) → releer y responder como si ya existiera.
- [x] T4.7: Manejar rama timeout del provider → dejar `pending`, responder `200`
      con `status: "pending"` y mensaje explícito de "en verificación" (se eligió
      `200` sobre `202`/`409` para simplificar el contrato de respuesta del cliente;
      el campo `status` es lo que distingue el caso, documentar en README).
- [x] T4.8: Manejar rama failure del provider → transición a `failed`, responder
      `200` con `status: "failed"`, sin tocar balance.
- [x] T4.9: Mapear `CashInOperation` → `CashInResponseDto` (`operation_id`, `status`,
      `amount`, `new_balance`).

## Fase 5 — POST /webhooks/payment

- [x] T5.1: `PaymentWebhookDto` con validación.
- [x] T5.2: Implementar `WebhooksService.handlePaymentWebhook()`:
      - Operación no encontrada → se elige la opción de **buffer real** (colección
        `pending_webhooks`, upsert por `operationId`), no solo log + 200: más
        robusto y con poco costo extra. `CashInService` drena el buffer justo
        después de `insertPending()`, evitando polling o jobs en background.
      - Operación encontrada → `OperationTransitionService.resolve()` (que envuelve
        `updateStatusIfPending`); si no matchea (ya terminal), no-op idempotente,
        responde 200 igual.
      - Si transición efectiva a `completed` → acredita balance, vía el mismo
        `OperationTransitionService` compartido con el flujo síncrono de cash-in
        (evita duplicar la regla "solo acreditar en transición efectiva" en dos
        lugares).
- [x] T5.3: Verificar explícitamente que un webhook `failed` no puede sobreescribir
      un estado `completed` ya alcanzado (y viceversa). Cubierto en
      `webhooks.e2e-spec.ts` ("does not let an out-of-order failed overwrite...").

## Fase 6 — Observabilidad

- [x] T6.1: Interceptor/middleware que genera o propaga `correlationId` (usa
      `Idempotency-Key` si existe) y lo inyecta en el logger contextual de cada
      request. Implementado con `AsyncLocalStorage` nativo de Node (sin
      dependencia externa) + `ContextualLogger` que extiende `ConsoleLogger` de
      Nest. También se devuelve como header `X-Correlation-Id` en la respuesta.
- [x] T6.2: Agregar logs con `operationId` + `correlationId` en los puntos clave:
      inicio de proceso, resultado del provider, transición de estado, webhook
      recibido. (El `correlationId` se agrega automáticamente vía
      `ContextualLogger`, no hay que pasarlo a mano en cada log.)

## Fase 7 — Tests (mínimos obligatorios del challenge)

- [x] T7.1: E2E — Happy path: `POST /cash-in` exitoso, balance actualizado
      correctamente.
- [x] T7.2: E2E — Mismo `Idempotency-Key` + mismo payload reintentado → misma
      respuesta exacta (verificado 3 veces seguidas), balance no se duplica.
- [x] T7.3: E2E — Mismo `Idempotency-Key` + payload distinto → `409`.
- [x] T7.4: E2E — 10 requests concurrentes con la misma `Idempotency-Key` → un
      único `operation_id` entre todas las respuestas y un único balance final
      (100, no 1000) — prueba indirecta de que el provider solo se llamó una vez,
      sin necesitar un spy sobre el mock.
- [x] T7.5: E2E — `payment_method: "card_force_timeout"` → operación queda `pending`,
      balance no se altera (se agregó también el caso `card_force_failure` → `failed`,
      balance no se altera).
- [x] T7.6: E2E — Webhook duplicado (enviar el mismo payload de webhook 2 veces) →
      balance acreditado una sola vez.
- [x] T7.7: E2E — Webhook fuera de orden (`failed` enviado después de que la
      operación ya está `completed`) → estado permanece `completed`.
- [x] T7.8: E2E — Webhook llega para un `operationId` que aún no existe en Mongo →
      no lanza excepción no controlada, se bufferiza en `pending_webhooks` y
      responde 200. El drenado del buffer al insertar la operación se prueba por
      separado en `cash-in.service.spec.ts` (unit, con mocks) porque solo ahí se
      puede forzar de forma determinista que el webhook exista *antes* del insert.
- [x] T7.9: Correr `npm test` y `npm run test:e2e` limpio (sin tests skip, sin
      console.error de errores no esperados). Verificado con 5 corridas repetidas
      de cada suite tras corregir el aislamiento de bases de datos entre archivos
      de test (ver plan.md, "Nota de aislamiento de tests").

## Fase 8 — README

- [x] T8.1: Sección "Arquitectura" con diagrama simple (puede ser ASCII, igual al de
      plan.md).
- [x] T8.2: Sección "Estrategia de idempotencia" — explicar por qué Mongo (índice
      único) es la fuente de verdad y Redis es optimización, no garantía.
- [x] T8.3: Sección "Manejo de concurrencia" — lock Redis + `$inc` atómico de balance.
- [x] T8.4: Sección "Estrategia de retry" — qué es seguro reintentar (todo, gracias a
      idempotencia) y qué código/mensaje debe usar el cliente ante timeout.
- [x] T8.5: Sección "Manejo de webhooks" — duplicados, fuera de orden, llegada
      temprana (con buffer real implementado, no la versión simplificada).
- [x] T8.6: **Sección obligatoria "Uso del agente de IA"** — decisiones tomadas
      antes de codear, qué generó bien el agente sin corrección, y los 4 bugs
      reales encontrados y corregidos durante el desarrollo (uuid ESM-only,
      índice único no garantizado al arrancar, aislamiento de tests entre
      archivos, desincronización entre main.ts y el helper de tests e2e).
- [x] T8.7: Instrucciones de setup y ejecución (`docker compose up`, `npm install`,
      `npm run start:dev`, `npm test`, `npm run test:e2e`), verificadas
      manualmente con curl contra los 3 métodos de pago del mock.

## Fase 9 — Revisión final

- [x] T9.1: Repasar los 10 escenarios del challenge original uno por uno y confirmar
      que cada uno está cubierto por código y/o test:
      1. Doble click → `returns the same response when retried...` ✅
      2. Retry automático de la app → mismo test que (1) ✅
      3. Múltiples pods concurrentes → `does not double-charge under N concurrent
         requests` (10 en paralelo) ✅
      4. Timeout del proveedor → `leaves the operation pending...on provider
         timeout` ✅
      5. Webhook duplicado → `ignores a duplicate webhook without crediting...` ✅
      6. Webhook fuera de orden → `does not let an out-of-order "failed"
         overwrite...` ✅
      7. Webhook antes que la respuesta del API → `buffers a webhook...` (e2e) +
         `applies a webhook that was buffered before the operation existed` (unit,
         drenado real) ✅
      8. **Fallo temporal de DB** → gap real encontrado en esta revisión: el plan
         lo documentaba desde la Fase 1 pero el código nunca lo implementaba.
         Corregido: `CashInService` ahora distingue `DuplicateIdempotencyKeyError`
         de cualquier otro fallo de Mongo (→ 503), cubierto por
         `cash-in.service.resilience.spec.ts` ✅
      9. Reinicio del servicio durante la operación → cubierto indirectamente por
         `does not release a lock held by a different token` (lock huérfano tras
         reinicio) + la garantía de que el estado persistido en Mongo permite
         retomar con seguridad ✅
      10. Race condition sobre el saldo → `applies concurrent credits without
          lost updates ($inc is atomic)` ✅
- [x] T9.2: Revisar red flags de la rúbrica — ninguno aplica a la solución final:
      idempotencia solo en memoria (no, usa índice único de Mongo), no considera
      multi-pod (sí lo considera, es el diseño central), retry indiscriminado
      contra el proveedor (no existe, nunca se reintenta automáticamente contra
      el provider), confía en webhook único (no, maneja duplicados/fuera de
      orden/temprano explícitamente), no escribe pruebas (26 unit + 16 e2e).
      Al revisar T9.1 se encontró y corrigió un gap real de "manejo de errores"
      (T9.1 punto 8) que hubiera sido un red flag de facto si no se detectaba.
- [x] T9.3: Limpiar código generado por el agente que no se usa, TODOs olvidados,
      logs de debug. Se eliminó `test/helpers/wallet.fixture.ts` (helper creado
      en la Fase 1, nunca usado — los e2e terminaron insertando fixtures
      directamente). Se corrigió `npm run lint` a 0 errores/0 warnings (antes:
      11 errores, 24 warnings — tipos `any` sin acotar en tests e2e, un floating
      promise en `main.ts`).
