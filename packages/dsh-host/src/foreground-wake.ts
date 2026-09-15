import { createHash } from 'node:crypto'
import { evaluateContactPolicy, type HeartbeatService } from '@personal-growth/personal-heartbeat'
import type { SendMessageStatus } from './send-message.js'

const keyFor = (kind: string, value: string) => `${kind}:${createHash('sha256').update(value).digest('hex')}`

/** Execution admission and contact admission are separate: quiet work still runs. */
export class ForegroundWakeRunner {
  constructor(private readonly service: HeartbeatService, private readonly clock = () => new Date().toISOString()) {}

  async run(input: { occurrenceId: string; at?: string }, execute: () => Promise<void>) {
    const id = keyFor('main-wake', input.occurrenceId)
    const at = this.clock()
    const duplicate = await this.service.ledger.transact(async tx => {
      const claimed = tx.claim(id, 'foreground', at)
      await tx.save()
      return claimed.duplicate
    })
    if (duplicate) return { status: 'duplicate', occurrenceId: input.occurrenceId }
    try {
      await execute()
      await this.service.ledger.transact(async tx => { tx.complete(id, this.clock(), 'NOOP'); await tx.save() })
      return { status: 'completed', occurrenceId: input.occurrenceId }
    } catch (error) {
      await this.service.ledger.transact(async tx => { tx.fail(id, this.clock(), 'core_error'); await tx.save() })
      throw error
    }
  }

  async deliver(key: string, send: () => Promise<SendMessageStatus>): Promise<SendMessageStatus> {
    const id = keyFor('main-contact', key)
    const at = this.clock()
    const admission = await this.service.ledger.transact(async tx => {
      const claim = tx.claim(id, 'foreground', at)
      if (claim.duplicate) return claim.occurrence?.status === 'completed' ? (claim.occurrence.actionType === 'MESSAGE_USER' ? 'already_sent' : 'denied') : 'unknown'
      const policy = evaluateContactPolicy(this.service.config, tx.state, at, 'normal')
      if (!policy.allowed) {
        tx.complete(id, at, 'NOOP', policy.code)
        await tx.save()
        return 'denied'
      }
      tx.reserveContact({ occurrenceId: id, at, localDay: policy.metadata.localDate, status: 'active' }, policy.metadata.localDate)
      await tx.save()
      return 'allowed'
    })
    if (admission !== 'allowed') return admission
    try {
      const status = await send()
      await this.service.ledger.transact(async tx => {
        if (status === 'sent' || status === 'already_sent') {
          tx.finalizeContact(id, 'MESSAGE_USER', at, 'normal')
          tx.complete(id, this.clock(), 'MESSAGE_USER')
        } else {
          tx.markContactUncertain(id)
          tx.fail(id, this.clock(), 'sink_error')
        }
        await tx.save()
      })
      return status
    } catch (error) {
      await this.service.ledger.transact(async tx => { tx.markContactUncertain(id); tx.fail(id, this.clock(), 'sink_error'); await tx.save() })
      throw error
    }
  }
}
