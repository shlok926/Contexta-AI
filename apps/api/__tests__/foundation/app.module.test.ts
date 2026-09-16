import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';

describe('AppModule (Foundation)', () => {
  let appModule: TestingModule;

  beforeAll(async () => {
    appModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
  });

  it('should compile the application module', () => {
    expect(appModule).toBeDefined();
  });

  it('should resolve required foundation modules', () => {
    const app = appModule.get(AppModule);
    expect(app).toBeDefined();
  });
});
