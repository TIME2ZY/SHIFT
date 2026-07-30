export interface PersistedMessage {
  id?: string;
  role: "user" | "assistant" | "system";
  agent?: string;
  agentId?: string;
  content: string;
  kind?: string;
  messageType?: string;
  invocationId?: string;
  exitCode?: number | null;
  createdAt?: string | number;
}

export interface MessagesResponse {
  messages: PersistedMessage[];
}
