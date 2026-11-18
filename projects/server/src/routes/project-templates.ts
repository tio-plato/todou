import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ProjectRef,
  ProjectTemplate,
  ProjectTemplateCreateInput,
  ProjectTemplateUpdateInput,
  TemplateApplyInput,
  TemplateApplyPlan,
  TemplateApplyResult,
  TemplatePreviewInput,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createProjectTemplate,
  deleteProjectTemplate,
  listProjectTemplates,
  updateProjectTemplate,
} from "../services/project-templates.ts";
import {
  applyTemplate,
  previewTemplateApply,
} from "../services/template-apply.ts";
import { roleTag } from "./role-tag.ts";

// Digits only: a built-in template is listed but never written to.
const templateParams = z.object({
  id: z.coerce.number().int().positive(),
});
const slugParam = z.object({ slug: ProjectRef });
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const listRoute = createRoute({
  method: "get",
  path: "/me/project-templates",
  summary: "The built-in project templates, then my own by name",
  responses: {
    200: { description: "Templates", ...jsonBody(z.array(ProjectTemplate)) },
  },
});

const createTemplateRoute = createRoute({
  method: "post",
  path: "/me/project-templates",
  summary:
    "Create a project template from a body, or from a project's current " +
    "statuses and labels",
  request: { body: jsonBody(ProjectTemplateCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(ProjectTemplate) } },
});

const updateRoute = createRoute({
  method: "put",
  path: "/me/project-templates/{id}",
  summary: "Replace one of my project templates (409 when revision is stale)",
  request: {
    params: templateParams,
    body: jsonBody(ProjectTemplateUpdateInput),
  },
  responses: { 200: { description: "Updated", ...jsonBody(ProjectTemplate) } },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/me/project-templates/{id}",
  summary: "Delete one of my project templates",
  request: { params: templateParams },
  responses: { 204: { description: "Deleted" } },
});

const previewRoute = createRoute({
  method: "post",
  path: "/projects/{slug}/template/preview",
  summary: `Every difference between this project and a template, one row each ${roleTag("status.manage")}`,
  request: { params: slugParam, body: jsonBody(TemplatePreviewInput) },
  responses: {
    200: { description: "Apply plan", ...jsonBody(TemplateApplyPlan) },
  },
});

const applyRoute = createRoute({
  method: "post",
  path: "/projects/{slug}/template/apply",
  summary: `Carry out the selected rows of a preview (409 once the project or the template changed) ${roleTag("status.manage")}`,
  request: { params: slugParam, body: jsonBody(TemplateApplyInput) },
  responses: {
    200: { description: "Applied", ...jsonBody(TemplateApplyResult) },
  },
});

export function projectTemplateRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(listRoute, async (c) =>
    c.json(await listProjectTemplates(c.get("appCtx"), c.get("user")), 200),
  );

  app.openapi(createTemplateRoute, async (c) =>
    c.json(
      await createProjectTemplate(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("json"),
      ),
      201,
    ),
  );

  app.openapi(updateRoute, async (c) =>
    c.json(
      await updateProjectTemplate(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
      200,
    ),
  );

  app.openapi(previewRoute, async (c) =>
    c.json(
      await previewTemplateApply(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("json").template,
      ),
      200,
    ),
  );

  app.openapi(applyRoute, async (c) =>
    c.json(
      await applyTemplate(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("json"),
      ),
      200,
    ),
  );

  app.openapi(deleteRoute, async (c) => {
    await deleteProjectTemplate(
      c.get("appCtx"),
      c.get("user"),
      c.req.valid("param").id,
    );
    return c.body(null, 204);
  });

  return app;
}
