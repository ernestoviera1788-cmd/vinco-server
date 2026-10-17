// Stable business-error codes. The native app maps these to en/es UI strings.
// Transport contract:
//   success:        HTTP 200 {"data": <payload>}
//   business error: HTTP 200 {"data": {"ok": false, "error": "CODE"}}
//   transport error: HTTP non-2xx {"error": "..."} (malformed request, server fault)

export class RpcBusinessError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ?? code);
    this.code = code;
  }
}

export function biz(code: string, detail?: string): never {
  throw new RpcBusinessError(code, detail);
}

// ---- Auth & account ----
export const INVALID_ARGS = 'INVALID_ARGS';
export const INVALID_EMAIL = 'INVALID_EMAIL';
export const INVALID_PASSWORD = 'INVALID_PASSWORD';
export const EMAIL_TAKEN = 'EMAIL_TAKEN';
export const PHONE_TAKEN = 'PHONE_TAKEN';
export const UNDERAGE = 'UNDERAGE';
export const INVALID_BIRTHDATE = 'INVALID_BIRTHDATE';
export const TERMS_NOT_ACCEPTED = 'TERMS_NOT_ACCEPTED';
export const INVALID_CREDENTIALS = 'INVALID_CREDENTIALS';
export const INVALID_TOKEN = 'INVALID_TOKEN';
export const ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED';
export const ACCOUNT_BANNED = 'ACCOUNT_BANNED';
export const ACCOUNT_DELETED = 'ACCOUNT_DELETED';
export const USER_NOT_FOUND = 'USER_NOT_FOUND';
export const OTP_INVALID = 'OTP_INVALID';
export const OTP_EXPIRED = 'OTP_EXPIRED';
export const OTP_ALREADY_USED = 'OTP_ALREADY_USED';
export const RESET_CODE_INVALID = 'RESET_CODE_INVALID';
export const RESET_CODE_EXPIRED = 'RESET_CODE_EXPIRED';
export const INVALID_LOCALE = 'INVALID_LOCALE';
export const INVALID_CONFIRM = 'INVALID_CONFIRM';

// ---- Profile & photos ----
export const PROFILE_NOT_FOUND = 'PROFILE_NOT_FOUND';
export const PHOTO_LIMIT_REACHED = 'PHOTO_LIMIT_REACHED';
export const PHOTO_TOO_LARGE = 'PHOTO_TOO_LARGE';
export const INVALID_MIME_TYPE = 'INVALID_MIME_TYPE';
export const PHOTO_NOT_FOUND = 'PHOTO_NOT_FOUND';
export const INVALID_PHOTO_ORDER = 'INVALID_PHOTO_ORDER';

// ---- Social ----
export const SELF_ACTION = 'SELF_ACTION';
export const TARGET_NOT_FOUND = 'TARGET_NOT_FOUND';
export const INVALID_REACTION = 'INVALID_REACTION';
export const ALREADY_REACTED = 'ALREADY_REACTED';
export const MATCH_NOT_FOUND = 'MATCH_NOT_FOUND';
export const ALREADY_BLOCKED = 'ALREADY_BLOCKED';
export const USER_BLOCKED = 'USER_BLOCKED'; // target blocked you or you blocked them
export const INVALID_REPORT_CATEGORY = 'INVALID_REPORT_CATEGORY';
export const EVIDENCE_TOO_LARGE = 'EVIDENCE_TOO_LARGE';
export const LIKES_GATED = 'LIKES_GATED'; // incoming-likes list requires premium

// ---- Messaging ----
export const CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND';
export const NOT_IN_CONVERSATION = 'NOT_IN_CONVERSATION';
export const MESSAGE_TOO_LONG = 'MESSAGE_TOO_LONG';
export const MESSAGE_EMPTY = 'MESSAGE_EMPTY';

// ---- Notifications ----
export const NOTIFICATION_NOT_FOUND = 'NOTIFICATION_NOT_FOUND';

// ---- Commerce ----
export const STRIPE_NOT_CONFIGURED = 'STRIPE_NOT_CONFIGURED';
export const STRIPE_ERROR = 'STRIPE_ERROR';
export const PLAN_NOT_FOUND = 'PLAN_NOT_FOUND';
export const BOOST_NOT_FOUND = 'BOOST_NOT_FOUND';
export const INVALID_CHECKOUT_KIND = 'INVALID_CHECKOUT_KIND';
export const CHECKOUT_SESSION_NOT_FOUND = 'CHECKOUT_SESSION_NOT_FOUND';
export const SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND';
export const PAYMENT_NOT_FOUND = 'PAYMENT_NOT_FOUND';
export const REFUND_ALREADY_REQUESTED = 'REFUND_ALREADY_REQUESTED';
export const INVALID_REFUND_REASON = 'INVALID_REFUND_REASON';

// ---- Admin ----
export const ADMIN_ONLY = 'ADMIN_ONLY';
export const INVALID_ROLE = 'INVALID_ROLE';
export const INVALID_STATUS = 'INVALID_STATUS';
export const ANNOUNCEMENT_NOT_FOUND = 'ANNOUNCEMENT_NOT_FOUND';
export const REPORT_NOT_FOUND = 'REPORT_NOT_FOUND';
export const SETTING_NOT_FOUND = 'SETTING_NOT_FOUND';
export const CANNOT_MODIFY_SUPER_ADMIN = 'CANNOT_MODIFY_SUPER_ADMIN';

// ---- Generic ----
export const NOT_FOUND = 'NOT_FOUND';
export const FORBIDDEN = 'FORBIDDEN';
export const RATE_LIMITED = 'RATE_LIMITED';
export const INTERNAL_ERROR = 'INTERNAL_ERROR';
