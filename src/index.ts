// backend/index.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import http from "http";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const MONGODB_URI = process.env.MONGODB_URI!;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretjwt";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "supersecret";

if (!MONGODB_URI) {
  console.error("MONGODB_URI not set");
  process.exit(1);
}

// Types
interface User {
  _id?: ObjectId;
  id: string;
  email: string;
  password: string;
  name: string;
  createdAt: number;
}

interface Team {
  _id?: ObjectId;
  id: string;
  name: string;
  ownerId: string;
  members: string[];
  createdAt: number;
}

interface Board {
  _id?: ObjectId;
  id: string;
  name: string;
  teamId: string | null;
  ownerId: string;
  isPersonal: boolean;
  createdAt: number;
}

interface Task {
  _id?: ObjectId;
  id: string;
  title: string;
  description?: string;
  column: "todo" | "inprogress" | "done" | "unsure";
  createdAt: number;
  order: number;
  boardId: string;
}

interface JwtPayload {
  userId: string;
  email: string;
}

// Extend Express Request interface
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// WebSocket client with user info
interface WebSocketClient extends WebSocket {
  userId?: string;
  boardId?: string;
}

(async () => {
  const mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  const db = mongo.db("taskboard");
  const usersCol = db.collection<User>("users");
  const teamsCol = db.collection<Team>("teams");
  const boardsCol = db.collection<Board>("boards");
  const tasksCol = db.collection<Task>("tasks");

  // Create indexes
  await usersCol.createIndex({ email: 1 }, { unique: true });
  await tasksCol.createIndex({ boardId: 1, column: 1, order: 1 });

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ================= Auth Middleware =================
  const authenticateToken = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    jwt.verify(token, JWT_SECRET, (err: any, user: JwtPayload) => {
      if (err) return res.status(403).json({ error: "Invalid token" });
      req.user = user;
      next();
    });
  };

  // ================= Auth Routes =================
  app.post("/auth/register", async (req: Request, res: Response) => {
    try {
      const { email, password, name } = req.body;

      if (!email || !password || !name) {
        return res
          .status(400)
          .json({ error: "Email, password, and name required" });
      }

      const existingUser = await usersCol.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ error: "User already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const user: User = {
        id: uuidv4(),
        email,
        password: hashedPassword,
        name,
        createdAt: Date.now(),
      };

      await usersCol.insertOne(user);

      const token = jwt.sign(
        { userId: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: "24h" }
      );
      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/auth/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "Email and password required" });
      }

      const user = await usersCol.findOne({ email });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = jwt.sign(
        { userId: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: "24h" }
      );
      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get(
    "/auth/me",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const user = await usersCol.findOne({ id: req.user!.userId });
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }

        res.json({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
          },
        });
      } catch (error) {
        console.error("Get user error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  // user route


// Add this to your backend routes
app.get("/users", authenticateToken, async (req: Request, res: Response) => {
  try {
    const users = await usersCol.find({}, { projection: { id: 1, email: 1, name: 1 } }).toArray();
    res.json(users);
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

  // ================= Team Routes =================
  app.post("/teams", authenticateToken, async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      const userId = req.user!.userId;

      if (!name) {
        return res.status(400).json({ error: "Team name required" });
      }

      const team: Team = {
        id: uuidv4(),
        name,
        ownerId: userId,
        members: [userId],
        createdAt: Date.now(),
      };

      await teamsCol.insertOne(team);
      res.json(team);
    } catch (error) {
      console.error("Create team error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/teams", authenticateToken, async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const teams = await teamsCol
        .find({
          $or: [{ ownerId: userId }, { members: userId }],
        })
        .toArray();
      res.json(teams);
    } catch (error) {
      console.error("Get teams error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get(
    "/teams/:teamId",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { teamId } = req.params;
        const userId = req.user!.userId;

        const team = await teamsCol.findOne({
          id: teamId,
          $or: [{ ownerId: userId }, { members: userId }],
        });

        if (!team) {
          return res.status(404).json({ error: "Team not found" });
        }

        res.json(team);
      } catch (error) {
        console.error("Get team error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.post(
    "/teams/:teamId/invite",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { teamId } = req.params;
        const { email } = req.body;
        const userId = req.user!.userId;

        const team = await teamsCol.findOne({ id: teamId });
        if (!team) {
          return res.status(404).json({ error: "Team not found" });
        }

        if (team.ownerId !== userId) {
          return res
            .status(403)
            .json({ error: "Only team owner can invite members" });
        }

        const userToAdd = await usersCol.findOne({ email });
        if (!userToAdd) {
          return res.status(404).json({ error: "User not found" });
        }

        if (team.members.includes(userToAdd.id)) {
          return res.status(400).json({ error: "User already in team" });
        }

        await teamsCol.updateOne(
          { id: teamId },
          { $push: { members: userToAdd.id } }
        );

        res.json({ success: true });
      } catch (error) {
        console.error("Invite to team error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.delete(
    "/teams/:teamId",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { teamId } = req.params;
        const userId = req.user!.userId;

        const team = await teamsCol.findOne({ id: teamId });
        if (!team) {
          return res.status(404).json({ error: "Team not found" });
        }

        if (team.ownerId !== userId) {
          return res
            .status(403)
            .json({ error: "Only team owner can delete the team" });
        }

        // Delete team and all its boards and tasks
        await teamsCol.deleteOne({ id: teamId });

        const teamBoards = await boardsCol.find({ teamId }).toArray();
        const boardIds = teamBoards.map((board) => board.id);

        await boardsCol.deleteMany({ teamId });
        await tasksCol.deleteMany({ boardId: { $in: boardIds } });

        res.json({ success: true });
      } catch (error) {
        console.error("Delete team error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  // ================= Board Routes =================
  app.post(
    "/boards",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { name, teamId, isPersonal } = req.body;
        const userId = req.user!.userId;

        if (!name) {
          return res.status(400).json({ error: "Board name required" });
        }

        // If team board, verify user is in team
        if (teamId) {
          const team = await teamsCol.findOne({ id: teamId, members: userId });
          if (!team) {
            return res.status(403).json({ error: "Not a member of this team" });
          }
        }

        const board: Board = {
          id: uuidv4(),
          name,
          teamId: teamId || null,
          ownerId: userId,
          isPersonal: Boolean(isPersonal),
          createdAt: Date.now(),
        };

        await boardsCol.insertOne(board);
        res.json(board);
      } catch (error) {
        console.error("Create board error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.get("/boards", authenticateToken, async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;

      // Get user's teams
      const userTeams = await teamsCol.find({ members: userId }).toArray();
      const teamIds = userTeams.map((t) => t.id);

      // Get personal boards and team boards
      const boards = await boardsCol
        .find({
          $or: [
            { ownerId: userId, isPersonal: true }, // Personal boards
            { teamId: { $in: teamIds } }, // Team boards where user is member
          ],
        })
        .toArray();

      res.json(boards);
    } catch (error) {
      console.error("Get boards error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get(
    "/boards/:boardId",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { boardId } = req.params;
        const userId = req.user!.userId;

        const board = await boardsCol.findOne({ id: boardId });
        if (!board) {
          return res.status(404).json({ error: "Board not found" });
        }

        // Verify access
        if (board.isPersonal && board.ownerId !== userId) {
          return res.status(403).json({ error: "Access denied" });
        }

        if (!board.isPersonal && board.teamId) {
          const team = await teamsCol.findOne({
            id: board.teamId,
            members: userId,
          });
          if (!team) {
            return res.status(403).json({ error: "Not a member of this team" });
          }
        }

        res.json(board);
      } catch (error) {
        console.error("Get board error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.put(
    "/boards/:boardId",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { boardId } = req.params;
        const { name } = req.body;
        const userId = req.user!.userId;

        if (!name) {
          return res.status(400).json({ error: "Board name required" });
        }

        const board = await boardsCol.findOne({ id: boardId });
        if (!board) {
          return res.status(404).json({ error: "Board not found" });
        }

        if (board.ownerId !== userId) {
          return res.status(403).json({ error: "Only board owner can edit" });
        }

        await boardsCol.updateOne({ id: boardId }, { $set: { name } });

        const updatedBoard = await boardsCol.findOne({ id: boardId });
        res.json(updatedBoard);
      } catch (error) {
        console.error("Update board error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.delete(
    "/boards/:boardId",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { boardId } = req.params;
        const userId = req.user!.userId;

        const board = await boardsCol.findOne({ id: boardId });
        if (!board) {
          return res.status(404).json({ error: "Board not found" });
        }

        if (board.ownerId !== userId) {
          return res.status(403).json({ error: "Only board owner can delete" });
        }

        // Delete board and all its tasks
        await boardsCol.deleteOne({ id: boardId });
        await tasksCol.deleteMany({ boardId });

        res.json({ success: true });
      } catch (error) {
        console.error("Delete board error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  // ================= Task Routes =================
  app.get(
    "/boards/:boardId/tasks",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { boardId } = req.params;
        const userId = req.user!.userId;

        // Verify user has access to this board
        const board = await boardsCol.findOne({ id: boardId });
        if (!board) {
          return res.status(404).json({ error: "Board not found" });
        }

        if (board.isPersonal && board.ownerId !== userId) {
          return res.status(403).json({ error: "Access denied" });
        }

        if (!board.isPersonal && board.teamId) {
          const team = await teamsCol.findOne({
            id: board.teamId!,
            members: userId,
          });
          if (!team) {
            return res.status(403).json({ error: "Not a member of this team" });
          }
        }

        const tasks = await tasksCol
          .find({ boardId })
          .sort({ column: 1, order: 1 })
          .toArray();
        res.json(tasks);
      } catch (error) {
        console.error("Get tasks error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.post(
    "/boards/:boardId/tasks",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { boardId } = req.params;
        const { title, column, description } = req.body;
        const userId = req.user!.userId;

        // Verify access
        const board = await boardsCol.findOne({ id: boardId });
        if (!board) return res.status(404).json({ error: "Board not found" });

        if (board.isPersonal && board.ownerId !== userId) {
          return res.status(403).json({ error: "Access denied" });
        }

        if (!board.isPersonal && board.teamId) {
          const team = await teamsCol.findOne({
            id: board.teamId!,
            members: userId,
          });
          if (!team)
            return res.status(403).json({ error: "Not a member of this team" });
        }

        if (!title) return res.status(400).json({ error: "title required" });

        const maxOrderDoc = await tasksCol
          .find({ boardId, column: column || "todo" })
          .sort({ order: -1 })
          .limit(1)
          .toArray();
        const nextOrder =
          maxOrderDoc[0]?.order != null ? maxOrderDoc[0].order + 1 : 0;

        const task: Task = {
          id: uuidv4(),
          title,
          description: description || "",
          column: column || "todo",
          createdAt: Date.now(),
          order: nextOrder,
          boardId,
        };

        await tasksCol.insertOne(task);
        broadcastToBoard(boardId, { type: "task_created", task, boardId });
        res.json(task);
      } catch (error) {
        console.error("Create task error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.put(
    "/tasks/:taskId",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { taskId } = req.params;
        const { title, description, column } = req.body;
        const userId = req.user!.userId;

        const task = await tasksCol.findOne({ id: taskId });
        if (!task) {
          return res.status(404).json({ error: "Task not found" });
        }

        // Verify access to the board
        const board = await boardsCol.findOne({ id: task.boardId });
        if (!board) return res.status(404).json({ error: "Board not found" });

        if (board.isPersonal && board.ownerId !== userId) {
          return res.status(403).json({ error: "Access denied" });
        }

        if (!board.isPersonal && board.teamId) {
          const team = await teamsCol.findOne({
            id: board.teamId!,
            members: userId,
          });
          if (!team)
            return res.status(403).json({ error: "Not a member of this team" });
        }

        const updateData: any = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (column !== undefined) updateData.column = column;

        await tasksCol.updateOne({ id: taskId }, { $set: updateData });

        const updatedTask = await tasksCol.findOne({ id: taskId });
        broadcastToBoard(task.boardId, {
          type: "task_updated",
          task: updatedTask,
          boardId: task.boardId,
        });
        res.json(updatedTask);
      } catch (error) {
        console.error("Update task error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  app.delete(
    "/tasks/:taskId",
    authenticateToken,
    async (req: Request, res: Response) => {
      try {
        const { taskId } = req.params;
        const userId = req.user!.userId;

        const task = await tasksCol.findOne({ id: taskId });
        if (!task) {
          return res.status(404).json({ error: "Task not found" });
        }

        // Verify access to the board
        const board = await boardsCol.findOne({ id: task.boardId });
        if (!board) return res.status(404).json({ error: "Board not found" });

        if (board.isPersonal && board.ownerId !== userId) {
          return res.status(403).json({ error: "Access denied" });
        }

        if (!board.isPersonal && board.teamId) {
          const team = await teamsCol.findOne({
            id: board.teamId!,
            members: userId,
          });
          if (!team)
            return res.status(403).json({ error: "Not a member of this team" });
        }

        await tasksCol.deleteOne({ id: taskId });
        broadcastToBoard(task.boardId, {
          type: "task_deleted",
          id: taskId,
          boardId: task.boardId,
        });
        res.json({ success: true });
      } catch (error) {
        console.error("Delete task error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  // ================= HTTP + WebSocket server =================
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, clientTracking: true });

  // Store connected clients by board
  const boardConnections = new Map<string, Set<WebSocketClient>>();

  function broadcastToBoard(boardId: string, payload: any) {
    const msg = JSON.stringify(payload);
    const clients = boardConnections.get(boardId);
    if (clients) {
      clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(msg);
        }
      });
    }
  }

  function broadcast(payload: any) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach((client: any) => {
      if (client.readyState === 1) {
        client.send(msg);
      }
    });
  }

  wss.on("connection", (ws: WebSocketClient, req) => {
    console.log("New WebSocket connection attempt");

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const boardId = url.searchParams.get("boardId");

    if (!token) {
      console.log("WebSocket connection rejected: No token");
      ws.close(1008, "Authentication required");
      return;
    }

    // Verify JWT token
    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) {
        console.log("WebSocket connection rejected: Invalid token");
        ws.close(1008, "Invalid token");
        return;
      }

      ws.userId = user.userId;

      if (boardId) {
        ws.boardId = boardId;

        // Add to board connections
        if (!boardConnections.has(boardId)) {
          boardConnections.set(boardId, new Set());
        }
        boardConnections.get(boardId)!.add(ws);
      }

      console.log(
        `User ${user.userId} connected to board ${boardId || "none"}`
      );
    });

    ws.on("message", async (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log("WebSocket message received:", msg.type);

        if (msg.type === "reorder") {
          const updates = msg.tasks as Task[];
          const boardId = msg.boardId;

          // Verify user has access to this board
          if (ws.userId && boardId) {
            const board = await boardsCol.findOne({ id: boardId });
            if (board) {
              const hasAccess = board.isPersonal
                ? board.ownerId === ws.userId
                : await teamsCol.findOne({
                    id: board.teamId!,
                    members: ws.userId,
                  });

              if (hasAccess) {
                console.log("Processing reorder for", updates.length, "tasks");

                // Update all tasks in a transaction
                for (const t of updates) {
                  await tasksCol.updateOne(
                    { id: t.id, boardId: boardId },
                    { $set: { column: t.column, order: t.order } }
                  );
                }

                // Get the updated tasks to broadcast
                const updatedTasks = await tasksCol
                  .find({ boardId })
                  .sort({ column: 1, order: 1 })
                  .toArray();

                broadcastToBoard(boardId, {
                  type: "tasks_reorder",
                  tasks: updatedTasks,
                  boardId,
                });

                console.log("Reorder completed and broadcasted");
              }
            }
          }
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
      }
    });

    ws.on("close", () => {
      if (ws.boardId && boardConnections.has(ws.boardId)) {
        boardConnections.get(ws.boardId)!.delete(ws);
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });

  // Health check endpoint
  app.get("/health", (req: Request, res: Response) => {
    res.json({ status: "OK", timestamp: new Date().toISOString() });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "Route not found" });
  });

  // Error handler
  app.use((error: any, req: Request, res: Response, next: NextFunction) => {
    console.error("Unhandled error:", error);
    res.status(500).json({ error: "Internal server error" });
  });

  server.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, shutting down gracefully");
    await mongo.close();
    server.close(() => {
      console.log("Process terminated");
    });
  });
})();
