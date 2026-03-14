export type CanvasTransform = {
  x: number;
  y: number;
  scale: number;
};

export type WindowType = 'terminal';

export type WindowItem = {
  id: string;
  sessionId: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  type: WindowType;
};

export type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
};
