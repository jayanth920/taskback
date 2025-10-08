// backend/types.ts
export type User = {
  id: string;
  email: string;
  password: string; // hashed
  name: string;
  createdAt: number;
};

export type Team = {
  id: string;
  name: string;
  ownerId: string; // user who created the team
  members: string[]; // user IDs
  createdAt: number;
};

export type Board = {
  id: string;
  name: string;
  teamId: string | null; // null for personal boards
  ownerId: string; // user who created the board
  isPersonal: boolean;
  createdAt: number;
};

export type Task = {
  id: string;
  title: string;
  description?: string;
  column: "todo" | "inprogress" | "done" | "unsure";
  createdAt: number;
  order: number;
  boardId: string; // which board this task belongs to
};