import type { CurrentUser } from './types'

/** Ladder, lowest to highest: a higher role has everything a lower one has. */
export type Role = 'user' | 'insider' | 'admin'

const ROLE_RANK: Record<Role, number> = { user: 0, insider: 1, admin: 2 }

/** The minimum role each not-yet-public feature needs. Rolling a feature out
 * to everyone is changing its value to `'user'`. */
export const FEATURES = {
  mobileEdit: 'insider',
} as const satisfies Record<string, Role>

export type FeatureName = keyof typeof FEATURES

function rankOf(role: string | undefined): number {
  return ROLE_RANK[role as Role] ?? 0
}

export function hasFeature(user: Pick<CurrentUser, 'role'> | null | undefined, feature: FeatureName): boolean {
  return rankOf(user?.role) >= ROLE_RANK[FEATURES[feature]]
}
