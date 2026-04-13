import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import { singleParam } from "../utils/route-params.js";
import {
  countUsersByRole,
  createRole,
  deleteRole,
  listRoles,
  renameRole,
} from "../lib/users.js";

function decodeRoleName(value: string): string {
  return decodeURIComponent(value).trim();
}

export async function listRolesHandler(_req: AuthRequest, res: Response) {
  try {
    const roles = await listRoles();
    return res.json({ roles });
  } catch {
    return res.status(500).json({ error: "Failed to load roles." });
  }
}

export async function createRoleHandler(req: AuthRequest, res: Response) {
  try {
    const { name } = req.body as { name?: string };
    if (!name) {
      return res.status(400).json({ error: "Role name is required." });
    }
    const createdRole = await createRole(String(name));
    return res.status(201).json({ role: createdRole });
  } catch {
    return res.status(500).json({ error: "Failed to create role." });
  }
}

export async function patchRoleHandler(req: AuthRequest, res: Response) {
  try {
    const name = singleParam(req.params.name);
    const { newName } = req.body as { newName?: string };
    const oldName = decodeRoleName(name ?? "");

    if (!newName || !oldName) {
      return res.status(400).json({ error: "Role names are required." });
    }

    if (oldName.toLowerCase() === "admin") {
      return res.status(400).json({ error: "Admin role cannot be edited." });
    }

    const renamed = await renameRole(oldName, String(newName));
    return res.json({ role: renamed });
  } catch (error) {
    if (error instanceof Error && error.message === "Role not found") {
      return res.status(404).json({ error: "Role not found." });
    }
    return res.status(500).json({ error: "Failed to update role." });
  }
}

export async function deleteRoleHandler(req: AuthRequest, res: Response) {
  try {
    const name = singleParam(req.params.name);
    const roleName = decodeRoleName(name ?? "");

    if (!roleName) {
      return res.status(400).json({ error: "Role name is required." });
    }

    if (roleName.toLowerCase() === "admin") {
      return res.status(400).json({ error: "Admin role cannot be deleted." });
    }

    const usersUsingRole = await countUsersByRole(roleName);
    if (usersUsingRole > 0) {
      return res.status(400).json({
        error: "Role is assigned to users and cannot be deleted.",
      });
    }

    const deleted = await deleteRole(roleName);
    if (!deleted) {
      return res.status(404).json({ error: "Role not found." });
    }

    return res.json({ message: "Role deleted successfully." });
  } catch {
    return res.status(500).json({ error: "Failed to delete role." });
  }
}
