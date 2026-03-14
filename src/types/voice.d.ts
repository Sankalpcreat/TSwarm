interface Window {
  SpeechRecognition?: any;
  webkitSpeechRecognition?: any;
}

declare interface SpeechRecognition {
  start(): void;
  stop(): void;
}
