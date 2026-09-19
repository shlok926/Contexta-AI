import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  
  // Preserve compatible CORS behavior
  const corsOrigins = configService.get<string>('CORS_ALLOWED_ORIGINS');
  app.enableCors({
    origin: corsOrigins ? (corsOrigins === '*' ? '*' : corsOrigins.split(',').map((o) => o.trim())) : true,
    credentials: true,
  });

  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port);
  console.log(`NestJS application is running on: http://localhost:${port}`);
}

bootstrap();
