import { enqueueMessage, markMessageDone, markMessagePending } from '../db.js';
import { steerRpcSession } from './rpc-session.js';

type QueueMessageInput = Parameters<typeof enqueueMessage>[0];

/** Persist a follow-up before injecting it into an active RPC turn. */
export function persistAndSteerMessage(
  folder: string,
  steerText: string,
  message: QueueMessageInput,
): boolean {
  const rowid = enqueueMessage(message, { status: 'steered' });
  let finalized = false;

  const steered = steerRpcSession(folder, steerText, {
    onSettled: () => {
      if (finalized) return;
      finalized = true;
      markMessageDone(rowid);
    },
    onFailed: () => {
      if (finalized) return;
      finalized = true;
      markMessagePending(rowid);
    },
  });

  if (!steered && !finalized) {
    finalized = true;
    markMessagePending(rowid);
  }
  return steered;
}
