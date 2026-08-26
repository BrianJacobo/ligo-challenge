import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { ContextualLogger } from '../../src/common/logger/contextual-logger';
import { configureApp } from '../../src/bootstrap';

/** Mirrors the production bootstrap in src/main.ts so e2e tests exercise the same setup. */
export async function createTestApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication({
    logger: new ContextualLogger(),
  });

  await configureApp(app);
  await app.init();

  return app;
}
