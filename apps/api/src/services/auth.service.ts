export class AuthService {
  async login(payload: any) {
    return { message: 'Login successful' };
  }

  async logout(userId: string) {
    return { message: 'Logout successful' };
  }
}

export const authService = new AuthService();
