// backend/types/express.d.ts
import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        email: string;
      };
    }
  }
}

// Add WebSocket type extensions
interface WebSocketClient extends WebSocket {
  userId?: string;
  boardId?: string;
}