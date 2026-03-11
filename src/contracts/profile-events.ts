export const PROFILE_MODERATION_EVENT_TOPICS = {
  userDeactivated: 'profile.user.deactivated.v1',
  userReactivated: 'profile.user.reactivated.v1'
} as const;

export type ProfileModerationEventTopic =
  (typeof PROFILE_MODERATION_EVENT_TOPICS)[keyof typeof PROFILE_MODERATION_EVENT_TOPICS];

export interface ProfileUserModerationEventData {
  user_id: string;
}

