export type NotificationMessage = {
  html: string;
  subject: string;
  text: string;
};

export type NotificationSink = {
  deliver(message: NotificationMessage): Promise<void>;
};
