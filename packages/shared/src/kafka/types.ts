export interface MailMessage {
  type?: string;
  to: string;
  subject: string;
  html: string;
}

export interface ConsumerLag {
  topic: string;
  partition: number;
  committedOffset: number;
  endOffset: number;
  lag: number;
  /**
   * False when the group has NO committed offset for this partition (offset
   * fetch returned -1). In that case `lag` is the full partition length, which
   * is an UPPER BOUND, not a true "behind" measure - the consumer may simply
   * not have started (or used fromBeginning:false and not yet committed).
   */
  hasCommittedOffset: boolean;
}

export interface ConsumerLagResult {
  groupId: string;
  /** Per-topic/partition rows; empty when the group has no committed offsets. */
  topics: ConsumerLag[];
  totalLag: number;
}

export interface KafkaHealth {
  connected: boolean;
  clientId: string;
  metadata?: {
    brokers: number;
    topics: string[];
  };
  /** Real consumer lag (high-water mark minus committed offset) when available. */
  lag?: ConsumerLagResult;
  error?: string;
}

export interface PublishOptions {
  key?: string | null;
  correlationId?: string;
  eventId?: string;
  eventType?: string;
  eventVersion?: number;
  occurredAt?: string;
  source?: string;
}

export interface ProducerInstance {
  connect(): Promise<void>;
  publish<T = Record<string, unknown>>(
    topic: string,
    message: T,
    options?: PublishOptions,
  ): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  healthCheck(): Promise<KafkaHealth>;
}

export interface ConsumerInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  healthCheck(): Promise<KafkaHealth>;
}