const reactMdComponent = `
import React, { FunctionComponent } from 'react';
import MarkdownElement from '../../MarkdownElement';

export const markdown[MD_COMPONENT_NAME] = \`[MARKDOWN]\`;
export const preview[MD_COMPONENT_NAME] = \`[PREVIEW]\`;
export const meta[MD_COMPONENT_NAME] = [MD_META];

const [MD_COMPONENT_NAME]: FunctionComponent = () => {
  return (
    <MarkdownElement 
      markdown={markdown[MD_COMPONENT_NAME]} 
      meta={meta[MD_COMPONENT_NAME]}
      showBreadcrumbs={true}
    />
  );
};

export default [MD_COMPONENT_NAME];`;

module.exports = { reactMdComponent };
