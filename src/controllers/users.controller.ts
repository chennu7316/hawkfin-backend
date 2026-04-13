import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import { singleParam } from "../utils/route-params.js";
import {
  createUser,
  deleteUserById,
  findUserByEmail,
  findUserById,
  listUsers,
  roleExists,
  updateUserById,
} from "../lib/users.js";

export async function listUsersHandler(req: AuthRequest, res: Response) {
  try {
    const users = await listUsers();
    return res.json({ users });
  } catch {
    return res.status(500).json({ error: "Failed to load users." });
  }
}

export async function createUserHandler(req: AuthRequest, res: Response) {
  try {
    const { firstName, lastName, email, role, password } = req.body as Record<
      string,
      unknown
    >;

    if (!firstName || !lastName || !email || !role || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }

    if (String(role).toLowerCase() === "admin") {
      return res.status(400).json({ error: "Admin user cannot be created from dashboard." });
    }

    const validRole = await roleExists(String(role));
    if (!validRole) {
      return res.status(400).json({ error: "Selected role is invalid." });
    }

    const existingUser = await findUserByEmail(String(email));
    if (existingUser) {
      return res.status(409).json({ error: "A user with this email already exists." });
    }

    const created = await createUser({
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      email: String(email).trim(),
      role: String(role).trim(),
      password: String(password),
      agreeTerms: true,
      marketingUpdates: false,
    });

    return res.status(201).json({
      user: {
        id: created.id,
        firstName: created.firstName,
        lastName: created.lastName,
        email: created.email,
        role: created.role,
      },
    });
  } catch {
    return res.status(500).json({ error: "Failed to add user." });
  }
}

export async function deleteUserHandler(req: AuthRequest, res: Response) {
  try {
    const id = singleParam(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "User id is required." });
    }

    if (req.auth!.sub === id) {
      return res.status(400).json({ error: "Admin cannot delete own account." });
    }

    const deleted = await deleteUserById(id);
    if (!deleted) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({ message: "User deleted successfully." });
  } catch {
    return res.status(500).json({ error: "Failed to delete user." });
  }
}

export async function patchUserHandler(req: AuthRequest, res: Response) {
  try {
    const id = singleParam(req.params.id);
    const { firstName, lastName, email, role } = req.body as Record<string, unknown>;

    if (!id || !firstName || !lastName || !email || !role) {
      return res.status(400).json({ error: "All fields are required." });
    }

    const existingUser = await findUserById(id);
    if (!existingUser) {
      return res.status(404).json({ error: "User not found." });
    }

    if (existingUser.role.toLowerCase() === "admin") {
      return res.status(400).json({ error: "Admin account cannot be edited from dashboard." });
    }

    if (String(role).toLowerCase() === "admin") {
      return res.status(400).json({ error: "User role cannot be changed to admin." });
    }

    const validRole = await roleExists(String(role));
    if (!validRole) {
      return res.status(400).json({ error: "Selected role is invalid." });
    }

    const emailInUse = await findUserByEmail(String(email));
    if (emailInUse && emailInUse.id !== id) {
      return res.status(409).json({ error: "A user with this email already exists." });
    }

    const updated = await updateUserById(id, {
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      email: String(email).trim(),
      role: String(role).trim(),
    });
    if (!updated) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({ user: updated });
  } catch {
    return res.status(500).json({ error: "Failed to update user." });
  }
}
