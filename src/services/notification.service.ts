import crypto from 'crypto';
import { NotificationChannel, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';

export interface OutboundMessage {
  userId?: string | null;
  channel: Exclude<NotificationChannel, 'in_app'>;
  recipient: string;
  template: string;
  text: string;
}

/** Messages sent in the current process; tests read this to assert delivery (e.g. reset tokens). */
export const outbox: OutboundMessage[] = [];

/**
 * Channel delivery. The "log" provider records the delivery and prints it (development);
 * plug real SMS/WhatsApp/email vendors in here once chosen (see spec §8).
 */
async function deliver(message: OutboundMessage) {
  const providerMessageId = crypto.randomUUID();
  await prisma.notificationDelivery.create({
    data: {
      userId: message.userId ?? null,
      channel: message.channel,
      provider: env.notificationProvider,
      recipient: message.recipient,
      template: message.template,
      status: 'sent',
      providerMessageId,
    },
  });
  if (env.isTest) {
    outbox.push(message);
  } else if (!env.isProduction) {
    logger.info('notification_sent', { channel: message.channel, recipient: message.recipient, template: message.template, text: message.text });
  } else {
    logger.info('notification_sent', { channel: message.channel, template: message.template, provider_message_id: providerMessageId });
  }
}

async function safeDeliver(message: OutboundMessage) {
  try {
    await deliver(message);
  } catch (err) {
    logger.error('notification_failed', { template: message.template, error: String(err) });
  }
}

export const NotificationService = {
  async inApp(userId: string, type: string, title: string, body: string, data?: Record<string, unknown>) {
    await prisma.notification.create({
      data: { userId, type, title, body, data: data as Prisma.InputJsonValue | undefined },
    });
  },

  async welcome(user: { id: string; baseRole: string; agriksenseId: string; phone: string | null; email: string | null }) {
    const text = `Welcome to AgriKSense! Your AgriKSense ID is ${user.agriksenseId}.`;
    // PRD: farmers get SMS, DCOs get WhatsApp, organizations get email.
    if (user.baseRole === 'farmer' && user.phone) await safeDeliver({ userId: user.id, channel: 'sms', recipient: user.phone, template: 'welcome', text });
    if (user.baseRole === 'dco' && user.phone) await safeDeliver({ userId: user.id, channel: 'whatsapp', recipient: user.phone, template: 'welcome', text });
    if (user.email) await safeDeliver({ userId: user.id, channel: 'email', recipient: user.email, template: 'welcome', text });
    await this.inApp(user.id, 'welcome', 'Welcome to AgriKSense', text, { agriksense_id: user.agriksenseId });
  },

  async passwordReset(user: { id: string; phone: string | null; email: string | null }, token: string) {
    const text = `Your AgriKSense password reset code is: ${token}. It expires in 30 minutes. If you did not request this, ignore this message.`;
    if (user.email) await safeDeliver({ userId: user.id, channel: 'email', recipient: user.email, template: 'password_reset', text });
    else if (user.phone) await safeDeliver({ userId: user.id, channel: 'sms', recipient: user.phone, template: 'password_reset', text });
  },
};
