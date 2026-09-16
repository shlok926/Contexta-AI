import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Preserve compatible CORS behavior if currently required
  app.enableCors();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`NestJS application is running on: http://localhost:${port}`);
}

bootstrap();
