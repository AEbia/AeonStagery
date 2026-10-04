import React from 'react';
import { ResourceFileBrowser } from './ResourceFileBrowser';

export const ResourcePanel: React.FC = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 8 }}>
      <ResourceFileBrowser />
    </div>
  );
};

export default ResourcePanel;
