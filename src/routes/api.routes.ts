import { Router } from "express";
import multer from "multer";
import * as authController from "../controllers/auth.controller.js";
import * as checkEmailController from "../controllers/check-email.controller.js";
import * as companiesController from "../controllers/companies.controller.js";
import * as contactController from "../controllers/contact.controller.js";
import * as rolesController from "../controllers/roles.controller.js";
import * as statementsController from "../controllers/statements.controller.js";
import * as usersController from "../controllers/users.controller.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 55 * 1024 * 1024 },
});

export const apiRouter = Router();

apiRouter.post("/login", authController.login);
apiRouter.post("/register", authController.register);
apiRouter.post("/check-email", checkEmailController.checkEmail);
apiRouter.post("/forgot-password", authController.forgotPassword);
apiRouter.post("/reset-password", authController.resetPassword);

apiRouter.get("/roles", rolesController.listRolesHandler);
apiRouter.post("/roles", requireAdmin, rolesController.createRoleHandler);
apiRouter.patch("/roles/:name", requireAdmin, rolesController.patchRoleHandler);
apiRouter.delete("/roles/:name", requireAdmin, rolesController.deleteRoleHandler);

apiRouter.get("/users", requireAdmin, usersController.listUsersHandler);
apiRouter.post("/users", requireAdmin, usersController.createUserHandler);
apiRouter.patch("/users/:id", requireAdmin, usersController.patchUserHandler);
apiRouter.delete("/users/:id", requireAdmin, usersController.deleteUserHandler);

apiRouter.post("/contact-messages", contactController.createContactMessageHandler);
apiRouter.get("/contact-messages", requireAdmin, contactController.listContactMessagesHandler);
apiRouter.patch(
  "/contact-messages/:id",
  requireAdmin,
  contactController.patchContactMessageHandler,
);

apiRouter.get("/companies", requireAuth, companiesController.listCompaniesHandler);
apiRouter.post("/companies", requireAuth, companiesController.createCompanyHandler);

apiRouter.post(
  "/statements/upload",
  requireAuth,
  upload.array("files", 30),
  statementsController.uploadStatementsHandler,
);
apiRouter.get("/statements/history", requireAuth, statementsController.statementHistoryHandler);
