import type { TabMark } from '../../types/document';
import { schema } from '../schema';

export const TOC_TAB: TabMark = { position: 9350, alignment: 'right', leader: 'dot' };

export const TOC_RAW_EMPTY = [
  '<w:sdt>',
  '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
  '<w:sdtContent>',
  '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>',
  '<w:r><w:instrText>TOC \\h \\o "1-5"</w:instrText></w:r>',
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>',
  '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  '</w:sdtContent>',
  '</w:sdt>',
].join('');

export function paragraph(text: string, attrs: Record<string, unknown> = {}) {
  return schema.node('paragraph', attrs, text ? [schema.text(text)] : []);
}

export function tocBlock() {
  return schema.node(
    'blockSdt',
    {
      sdtType: 'richText',
      alias: 'Table of Contents',
      rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
      rawPreserveXml: TOC_RAW_EMPTY,
      rawPreserveText: '',
    },
    [paragraph('')]
  );
}

export function rawTocBlock(rawPreserveXml: string, rawPreserveText = 'Heading\t3') {
  return schema.node(
    'blockSdt',
    {
      sdtType: 'richText',
      alias: 'Table of Contents',
      rawPropertiesXml: '<w:sdtPr><w:alias w:val="Table of Contents"/></w:sdtPr>',
      rawPreserveXml,
      rawPreserveText,
    },
    [paragraph(rawPreserveText)]
  );
}

export { schema };
