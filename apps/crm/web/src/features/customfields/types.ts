export const customFieldEntities = ['Organization', 'Opportunity', 'Contract'] as const;
export type CustomFieldEntity = (typeof customFieldEntities)[number];

export const customFieldTypes = ['Text', 'Number', 'Date', 'Boolean', 'Select'] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];

export interface CustomFieldDefinition {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
  order: number;
  hint: string | null;
  isActive: boolean;
}

/** A field together with this record's answer (FR-ADM-04). */
export interface CustomFieldValue {
  definitionId: string;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
  hint: string | null;
  value: string | null;
}

export interface CustomFieldRequest {
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
  order: number;
  hint: string | null;
}
