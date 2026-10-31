import type { Message } from '@ag-ui/core';

// Message IDs survive history replay even when metadata does not.
export const scheduledTaskMessagePrefix = 'woofy:scheduled_task:';
export const legacyScheduledTaskMessagePrefix = 'opendots:scheduled_task:';

export function isScheduledTaskMessage(
  message: Pick<Message, 'id' | 'role' | 'metadata'>,
): boolean {
  if (message.role !== 'user') return false;
  if (
    message.id.startsWith(scheduledTaskMessagePrefix) ||
    message.id.startsWith(legacyScheduledTaskMessagePrefix)
  )
    return true;
  const metadata = message.metadata;
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    (('woofySource' in metadata && metadata.woofySource === 'scheduled_task') ||
      ('opendotsSource' in metadata &&
        metadata.opendotsSource === 'scheduled_task'))
  );
}
