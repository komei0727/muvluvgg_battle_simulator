export interface Clock {
  /** Returns current time as milliseconds since epoch. */
  now(): number;
}
