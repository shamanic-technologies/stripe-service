export const TEST_API_KEY = "test-secret-key";
export const TEST_ORG_ID = "org_test_uuid";
export const TEST_USER_ID = "user_test_uuid";

export function authHeaders(): Record<string, string> {
  return {
    "X-API-Key": TEST_API_KEY,
    "x-org-id": TEST_ORG_ID,
    "x-user-id": TEST_USER_ID,
  };
}
