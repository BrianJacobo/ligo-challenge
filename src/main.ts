import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ContextualLogger } from './common/logger/contextual-logger';
import { configureApp } from './bootstrap';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ContextualLogger(),
  });

  await configureApp(app);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((error: unknown) => {
  console.error('Failed to start application', error);
  process.exit(1);
});
