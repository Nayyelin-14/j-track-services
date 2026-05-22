import { getKafkaProducer } from "@jtrack/shared/kafka/producer";

export const kafka = getKafkaProducer("auth-service");
