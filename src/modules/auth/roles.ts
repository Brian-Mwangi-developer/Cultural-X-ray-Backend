import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";

/**
 * Who can do what inside an agency or a workspace. The same four roles exist in both.
 * An agency role never exceeds the access a client grants; that cap is applied per
 * connection, not here.
 */
export const statement = {
  ...defaultStatements,
  map: ["read", "build"],
  brief: ["read", "write"],
  adCheck: ["read", "run"],
  client: ["add", "disconnect"],
  billing: ["manage"],
} as const;

export const ac = createAccessControl(statement);

const work = { map: ["read", "build"], brief: ["read", "write"], adCheck: ["read", "run"] } as const;

export const roles = {
  owner: ac.newRole({ ...ownerAc.statements, ...work, client: ["add", "disconnect"], billing: ["manage"] }),
  admin: ac.newRole({ ...adminAc.statements, ...work, client: ["add", "disconnect"] }),
  strategist: ac.newRole({ ...work }),
  viewer: ac.newRole({ map: ["read"], brief: ["read"], adCheck: ["read"] }),
};

export type RoleName = keyof typeof roles;
export const ROLE_NAMES = Object.keys(roles) as RoleName[];
export const INVITABLE_ROLES: RoleName[] = ["admin", "strategist", "viewer"];
export const MANAGER_ROLES: RoleName[] = ["owner", "admin"];

export const isRole = (value: string): value is RoleName => (ROLE_NAMES as string[]).includes(value);
