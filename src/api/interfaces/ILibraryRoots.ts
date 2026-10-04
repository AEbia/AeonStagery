export interface ILibraryRoots {
  getRoots(): string[];
  subscribe(listener: () => void): () => void;
}
