export type TodayHandle = {
  refreshAfterCreate: () => Promise<(() => boolean) | null>;
  refreshAfterChange: () => Promise<void>;
};
