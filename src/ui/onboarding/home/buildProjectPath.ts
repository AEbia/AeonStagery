export const buildProjectPath = (location: string, name: string) => {
  const cleanLocation = location.trim().replace(/[\\/]+$/, '');
  const cleanName = name.trim();
  if (!cleanLocation) return cleanName;
  if (!cleanName) return cleanLocation;
  return `${cleanLocation}/${cleanName}`;
};
