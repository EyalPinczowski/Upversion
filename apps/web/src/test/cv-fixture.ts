/**
 * A fictional CV for the privacy test. Everything here is invented: the person, the contact
 * details and the canary sentence. The canary and the contact details must never leave the
 * browser; the skills, role and tools are what the review screen may legitimately send.
 */
export const CANARY = 'The violet heron crosses the amber bridge at seven CANARY-4f9c1e7a';

export const CONTACT = {
  name: 'Dana Q. Example',
  email: 'dana.example@mailbox.example',
  phone: '+1 555 010 4477',
  address: '42 Fictional Lane, Springfield 00000',
  linkedin: 'https://www.linkedin.com/in/dana-example-canary',
} as const;

export const CV_LINES = [
  CONTACT.name,
  `${CONTACT.email} | ${CONTACT.phone}`,
  CONTACT.address,
  CONTACT.linkedin,
  '',
  'Experience',
  'Operations Coordinator, 2019 - 2023',
  `Built Excel reports and SQL queries for the weekly review. ${CANARY}.`,
  'Ran project management for vendor onboarding and tracked tasks in Jira.',
  '',
  'Education',
  'B.Sc. in Industrial Engineering',
  '',
  'Skills',
  'Excel, SQL, Jira, project management',
];

export const CV_TEXT = CV_LINES.join('\n');

/** Every string that must not appear in any request, URL, header or web storage. */
export const FORBIDDEN = [
  'CANARY-4f9c1e7a',
  'violet heron',
  CONTACT.email,
  'dana.example',
  CONTACT.phone,
  '555 010',
  'Fictional Lane',
  'linkedin.com',
  'dana-example-canary',
  CONTACT.name,
];
