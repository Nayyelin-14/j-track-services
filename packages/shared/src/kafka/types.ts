export interface MailMessage {
  type?: string;
  to: string;
  subject: string;
  html: string;
}

export interface KafkaHealth {
  connected: boolean;
  clientId: string;
  metadata?: {
    brokers: number;
    topics: string[];
  };
  error?: string;
}

export interface ProducerInstance {
  connect(): Promise<void>;
  publish(topic: string, message: MailMessage): Promise<void>;
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
