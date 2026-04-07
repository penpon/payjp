export type AppState = 'loading' | 'not_linked' | 'linked' | 'error';

export interface SessionResponse {
  linked: boolean;
}
