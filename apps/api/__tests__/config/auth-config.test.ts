import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  validateAuthConfig,
  AuthConfigSchema,
  AuthConfig,
} from '../../src/modules/core/config/auth-config.schema.js';

describe('N2.1 Auth Configuration & Validation', () => {
  const validSymmetricSecret = 'a-super-secret-jwt-key-with-more-than-32-chars-long';
  const validPublicKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...\n-----END PUBLIC KEY-----';
  const validAnonKey = 'eyJh-valid-anon-key-min-10-chars';

  describe('Symmetric Strategy Validation', () => {
    it('should successfully validate a valid symmetric configuration', () => {
      const config = {
        NODE_ENV: 'test',
        PORT: 3000,
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_PROFILE: 'symmetric',
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      const result = validateAuthConfig(config);
      expect(result).toBeDefined();
      expect(result.NODE_ENV).toBe('test');
      expect(result.PORT).toBe(3000);
      expect(result.SUPABASE_URL).toBe('http://127.0.0.1:54321');
      expect(result.SUPABASE_ANON_KEY).toBe(validAnonKey);
      expect(result.SUPABASE_JWT_SECRET).toBe(validSymmetricSecret);
      expect(result.SUPABASE_JWT_AUDIENCE).toBe('authenticated');
      expect(result.ENABLE_PRIVILEGED_EXECUTION).toBe(false);
    });

    it('should default strategy to symmetric if neither profile nor strategy is specified', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      const result = validateAuthConfig(config);
      expect(result).toBeDefined();
      expect(result.PORT).toBe(3000);
      expect(result.NODE_ENV).toBe('development');
    });

    it('should support JWT_VERIFICATION_STRATEGY alias for symmetric mode', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_STRATEGY: 'symmetric',
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      const result = validateAuthConfig(config);
      expect(result).toBeDefined();
    });

    it('should fail closed when SUPABASE_JWT_SECRET is missing in symmetric mode', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_PROFILE: 'symmetric',
      };

      expect(() => validateAuthConfig(config)).toThrow(
        /SUPABASE_JWT_SECRET is required when verification strategy is symmetric/
      );
    });

    it('should fail closed when SUPABASE_JWT_SECRET is shorter than 32 characters', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_PROFILE: 'symmetric',
        SUPABASE_JWT_SECRET: 'short-secret-under-32-chars!', // 29 chars
      };

      expect(() => validateAuthConfig(config)).toThrow(
        /SUPABASE_JWT_SECRET must be at least 32 characters/
      );
    });
  });

  describe('Asymmetric Strategy Validation', () => {
    it('should successfully validate asymmetric configuration with SUPABASE_JWKS_URL', () => {
      const config = {
        SUPABASE_URL: 'https://project-ref.supabase.co',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_PROFILE: 'asymmetric',
        SUPABASE_JWKS_URL: 'https://project-ref.supabase.co/auth/v1/.well-known/jwks.json',
      };

      const result = validateAuthConfig(config);
      expect(result).toBeDefined();
      expect(result.SUPABASE_JWKS_URL).toBe(
        'https://project-ref.supabase.co/auth/v1/.well-known/jwks.json'
      );
    });

    it('should successfully validate asymmetric configuration with SUPABASE_JWT_PUBLIC_KEY', () => {
      const config = {
        SUPABASE_URL: 'https://project-ref.supabase.co',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_PROFILE: 'asymmetric',
        SUPABASE_JWT_PUBLIC_KEY: validPublicKey,
      };

      const result = validateAuthConfig(config);
      expect(result).toBeDefined();
      expect(result.SUPABASE_JWT_PUBLIC_KEY).toBe(validPublicKey);
    });

    it('should fail closed when asymmetric mode has neither JWKS URL nor public key', () => {
      const config = {
        SUPABASE_URL: 'https://project-ref.supabase.co',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_PROFILE: 'asymmetric',
      };

      expect(() => validateAuthConfig(config)).toThrow(
        /Either SUPABASE_JWKS_URL or SUPABASE_JWT_PUBLIC_KEY is required/
      );
    });

    it('should fail closed when SUPABASE_JWKS_URL is not a valid URL', () => {
      const config = {
        SUPABASE_URL: 'https://project-ref.supabase.co',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_PROFILE: 'asymmetric',
        SUPABASE_JWKS_URL: 'not-a-valid-jwks-url',
      };

      expect(() => validateAuthConfig(config)).toThrow(/SUPABASE_JWKS_URL must be a valid URL/);
    });
  });

  describe('Required Variables & Type Checking', () => {
    it('should fail closed when SUPABASE_URL is missing', () => {
      const config = {
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      expect(() => validateAuthConfig(config)).toThrow(/SUPABASE_URL: SUPABASE_URL is required/);
    });

    it('should fail closed when SUPABASE_URL is malformed', () => {
      const config = {
        SUPABASE_URL: 'invalid-url-string',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      expect(() => validateAuthConfig(config)).toThrow(/SUPABASE_URL must be a valid URL/);
    });

    it('should fail closed when SUPABASE_ANON_KEY is missing or too short', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: 'short',
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      expect(() => validateAuthConfig(config)).toThrow(
        /SUPABASE_ANON_KEY must be at least 10 characters/
      );
    });

    it('should fail closed on invalid NODE_ENV enum value', () => {
      const config = {
        NODE_ENV: 'invalid_environment',
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      expect(() => validateAuthConfig(config)).toThrow(/NODE_ENV/);
    });

    it('should coerce valid numeric PORT string', () => {
      const config = {
        PORT: '8080',
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      const result = validateAuthConfig(config);
      expect(result.PORT).toBe(8080);
    });

    it('should fail closed when PORT is not a valid number', () => {
      const config = {
        PORT: 'not-a-number',
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
      };

      expect(() => validateAuthConfig(config)).toThrow(/PORT/);
    });
  });

  describe('Privileged Execution Quarantine', () => {
    it('should pass without SUPABASE_SERVICE_ROLE_KEY when ENABLE_PRIVILEGED_EXECUTION is false', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
        ENABLE_PRIVILEGED_EXECUTION: false,
      };

      const result = validateAuthConfig(config);
      expect(result.ENABLE_PRIVILEGED_EXECUTION).toBe(false);
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    });

    it('should fail closed if ENABLE_PRIVILEGED_EXECUTION is true but SUPABASE_SERVICE_ROLE_KEY is omitted', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
        ENABLE_PRIVILEGED_EXECUTION: true,
      };

      expect(() => validateAuthConfig(config)).toThrow(
        /SUPABASE_SERVICE_ROLE_KEY is required when ENABLE_PRIVILEGED_EXECUTION is true/
      );
    });

    it('should pass if ENABLE_PRIVILEGED_EXECUTION is true and SUPABASE_SERVICE_ROLE_KEY is provided', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
        ENABLE_PRIVILEGED_EXECUTION: true,
        SUPABASE_SERVICE_ROLE_KEY: 'valid-service-role-key-min-10-chars',
      };

      const result = validateAuthConfig(config);
      expect(result.ENABLE_PRIVILEGED_EXECUTION).toBe(true);
      expect(result.SUPABASE_SERVICE_ROLE_KEY).toBe('valid-service-role-key-min-10-chars');
    });

    it('should correctly coerce string "1" and "true" for ENABLE_PRIVILEGED_EXECUTION', () => {
      const configWith1 = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
        ENABLE_PRIVILEGED_EXECUTION: '1',
        SUPABASE_SERVICE_ROLE_KEY: 'valid-service-role-key-min-10-chars',
      };
      expect(validateAuthConfig(configWith1).ENABLE_PRIVILEGED_EXECUTION).toBe(true);

      const configWithTrue = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
        ENABLE_PRIVILEGED_EXECUTION: 'true',
        SUPABASE_SERVICE_ROLE_KEY: 'valid-service-role-key-min-10-chars',
      };
      expect(validateAuthConfig(configWithTrue).ENABLE_PRIVILEGED_EXECUTION).toBe(true);
    });

    it('should correctly coerce string "0" and "false" for ENABLE_PRIVILEGED_EXECUTION', () => {
      const configWith0 = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
        ENABLE_PRIVILEGED_EXECUTION: '0',
      };
      expect(validateAuthConfig(configWith0).ENABLE_PRIVILEGED_EXECUTION).toBe(false);

      const configWithFalse = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
        ENABLE_PRIVILEGED_EXECUTION: 'false',
      };
      expect(validateAuthConfig(configWithFalse).ENABLE_PRIVILEGED_EXECUTION).toBe(false);
    });

    it('should fail closed when ENABLE_PRIVILEGED_EXECUTION is an invalid string', () => {
      const config = {
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_ANON_KEY: validAnonKey,
        SUPABASE_JWT_SECRET: validSymmetricSecret,
        ENABLE_PRIVILEGED_EXECUTION: 'invalid-boolean-string',
      };

      expect(() => validateAuthConfig(config)).toThrow(
        /ENABLE_PRIVILEGED_EXECUTION must be a boolean/
      );
    });
  });

  describe('Secret Masking & Zero Leakage in Error Output', () => {
    it('should never expose sensitive secret values in thrown error messages', () => {
      const secretToHide = 'SUPER_SENSITIVE_LEAKABLE_SECRET_VALUE_12345';
      const config = {
        SUPABASE_URL: 'not-a-valid-url',
        SUPABASE_ANON_KEY: validAnonKey,
        JWT_VERIFICATION_PROFILE: 'symmetric',
        SUPABASE_JWT_SECRET: secretToHide,
      };

      try {
        validateAuthConfig(config);
        expect(true).toBe(false); // Should not be reached
      } catch (err: unknown) {
        const errorMessage = (err as Error).message;
        expect(errorMessage).toContain('SUPABASE_URL must be a valid URL');
        expect(errorMessage).not.toContain(secretToHide);
      }
    });
  });

  describe('NestJS DI Integration', () => {
    let moduleRef: TestingModule;
    const originalEnv = { ...process.env };

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      process.env.PORT = '3000';
      process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
      process.env.SUPABASE_ANON_KEY = validAnonKey;
      process.env.JWT_VERIFICATION_PROFILE = 'symmetric';
      process.env.SUPABASE_JWT_SECRET = validSymmetricSecret;
      process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            validate: validateAuthConfig,
          }),
        ],
      }).compile();
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('should resolve ConfigService through NestJS DI with validated values', () => {
      const configService = moduleRef.get<ConfigService<AuthConfig>>(ConfigService);
      expect(configService).toBeDefined();

      expect(configService.get('NODE_ENV')).toBe('test');
      expect(configService.get('PORT')).toBe(3000);
      expect(configService.get('SUPABASE_URL')).toBe('http://127.0.0.1:54321');
      expect(configService.get('SUPABASE_ANON_KEY')).toBe(validAnonKey);
      expect(configService.get('SUPABASE_JWT_SECRET')).toBe(validSymmetricSecret);
      expect(configService.get('SUPABASE_JWT_AUDIENCE')).toBe('authenticated');
    });
  });
});
