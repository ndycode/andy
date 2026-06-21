import { describe, expect, test } from "bun:test";
import { deleteUser as rootDeleteUser, resolveUserId as rootResolveUserId } from "./index";
import { deleteUser, resolveUserId } from "./user-queries";

describe("user-queries boundary", () => {
  test("owns user identity and deletion helpers behind the package root", () => {
    expect(resolveUserId).toBe(rootResolveUserId);
    expect(deleteUser).toBe(rootDeleteUser);
  });
});
