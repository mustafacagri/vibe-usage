// An asynchronous preview belongs to one revision of a form. Changing the form, closing it,
// or requesting another preview invalidates both the previous result and its pending errors.
export function createPreviewState<Request, Preview>(fingerprint: (request: Request) => string) {
  let revision = 0;
  let reviewed: { key: string; request: Request; preview: Preview } | null = null;
  return {
    clear(): void {
      revision++;
      reviewed = null;
    },
    async load(request: Request, fetch: (request: Request) => Promise<Preview>, current: () => Request): Promise<Preview | null> {
      const generation = ++revision;
      const key = fingerprint(request);
      reviewed = null;
      const valid = (): boolean => generation === revision && key === fingerprint(current());
      try {
        const preview = await fetch(request);
        if (!valid()) return null;
        reviewed = { key, request, preview };
        return preview;
      } catch (error) {
        if (valid()) throw error;
        return null;
      }
    },
    read(request: Request): { request: Request; preview: Preview } | null {
      return reviewed?.key === fingerprint(request) ? { request: reviewed.request, preview: reviewed.preview } : null;
    }
  };
}
