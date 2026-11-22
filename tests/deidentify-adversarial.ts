/*
 * The adversarial review's inputs (review of 2026-11-22), with variants of each class of
 * leak, and the reviewer's client sheet. Invented people, places and numbers only.
 * Each probe lists the strings that must not survive (compared ignoring case and
 * accents) and, where it matters, what must survive or be reported.
 */
import type { ClientSheet } from "../src/main/deidentify/index.ts";

export const REVIEW_TODAY = new Date("2026-11-22T12:00:00Z");

export const REVIEW_SHEET: ClientSheet = {
  client: { firstName: "Mateo", lastName: "Ficticio Gómez", nicknames: ["Teo"], dateOfBirth: "2020-03-14" },
  caregivers: [
    { firstName: "Lucía", lastName: "Ficticio", relation: "mother" },
    { firstName: "Andrés", lastName: "Ficticio", relation: "father" },
  ],
  family: [{ firstName: "Valeria", lastName: "Ficticio Gómez", relation: "sister" }],
  professionals: [
    { firstName: "Daniela", lastName: "Muestra", relation: "BCBA" },
    { firstName: "Hope", lastName: "Brown", relation: "teacher" },
  ],
  schools: ["José Martí Elementary School"],
  addresses: ["4471 SW 12th Terrace, Apt 3, Miami, FL 33135"],
  phones: ["(305) 555-0142"],
  emails: ["lucia.ficticio@example.com"],
  ids: ["FL123456789", "9876543210"],
};

export interface Probe {
  group: string;
  text: string;
  hide: string[];
  keep?: string[];
}

const DOB_FORMS = [
  "14-Mar-2020", "14-mar-20", "Mar-14-2020", "14Mar2020", "14MAR20", "14/Mar/2020", "14.Mar.2020", "Mar/14/2020", "Mar-14-20",
  "2020/03/14", "2020.03.14", "2020-03-14", "03/14/2020", "3/14/20", "3-14-20", "03.14.2020", "March 14, 2020", "March 14 , 2020",
  "Mar. 14th 2020", "14 March 2020", "14th of March, 2020", "14 de marzo de 2020", "marzo 14, 2020", "14-MARZO-2020",
];

export const PROBES: Probe[] = [
  // B2: the date of birth in every format, alone and in a sentence
  ...DOB_FORMS.map((d) => ({ group: "B2 date of birth", text: `DOB: ${d}.`, hide: [d] })),
  ...DOB_FORMS.slice(0, 8).map((d) => ({ group: "B2 date of birth", text: `He was born on ${d} in Miami.`, hide: [d, "Miami"] })),
  { group: "B2 date of birth", text: "Birthday: 3/14", hide: ["3/14"] },
  { group: "B2 date of birth", text: "Su cumpleaños es el 14/3.", hide: ["14/3"] },
  { group: "B2 date of birth", text: "Party on 14th March", hide: ["14th March"] },
  { group: "B2 date of birth", text: "cumple el 14 de marzo. 14th March.", hide: ["14 de marzo", "14th March"] },
  { group: "B2 date of birth", text: "Born in March 2020; birthday March 14.", hide: ["March 2020", "March 14"] },
  { group: "B2 anniversary", text: "He turned 6 on 03/14/2026.", hide: ["03/14/2026"] },
  { group: "B2 anniversary", text: "His birthday party was March 14, 2026.", hide: ["March 14, 2026"] },
  { group: "B2 anniversary", text: "Cumplió 6 el 14 de marzo de 2026.", hide: ["14 de marzo de 2026"] },
  { group: "B2 anniversary", text: "Celebrated 14-Mar-2025 at home.", hide: ["14-Mar-2025"] },
  // H4: old dates in the same formats
  { group: "H4 old dates", text: "Diagnosed 14-Jun-2019 and re-evaluated 02-Feb-2023.", hide: ["14-Jun-2019", "02-Feb-2023"] },
  { group: "H4 old dates", text: "Seen 2019/06/14; next 2023.02.02.", hide: ["2019/06/14", "2023.02.02"] },
  { group: "H4 old dates", text: "Recent visit 10/02/2026 stays.", hide: [], keep: ["10/02/2026"] },
  // B3: the sheet's address, abbreviated and without its number
  { group: "B3 address", text: "4471 SW 12th Terr., Unit 3, Miami FL 33135", hide: ["4471", "12th", "Terr", "Unit 3", "Miami", "33135"] },
  { group: "B3 address", text: "Lives on SW 12th Terrace near the park.", hide: ["12th Terrace"] },
  { group: "B3 address", text: "4471 Southwest Twelfth Terrace", hide: ["4471", "Twelfth"] },
  { group: "B3 address", text: "4471 S.W. 12 Terrace #3", hide: ["4471", "12 Terrace"] },
  { group: "B3 address", text: "Home is 4471 SW 12 Ter apt 3.", hide: ["4471", "12 Ter"] },
  { group: "B3 address", text: "address: 4471 sw 12th terrace, apt 3, miami, fl 33135", hide: ["4471", "12th terrace", "miami", "33135"] },
  { group: "B3 address", text: "4471 SW 12th Trce", hide: ["4471", "12th Trce"] },
  { group: "B3 address", text: "They moved from 4471 SW 12th Terrace last year.", hide: ["4471", "12th Terrace"] },
  // City (owner's decision): the sheet address's city, alone
  { group: "City", text: "The family lives in Miami.", hide: ["Miami"] },
  { group: "City", text: "Viven en miami desde 2021.", hide: ["miami"], keep: ["2021"] },
  { group: "City", text: "MIAMI, FL", hide: ["MIAMI"] },
  // B4: the school, short forms and initials
  { group: "B4 school", text: "He attends Marti Elementary.", hide: ["Marti Elementary"] },
  { group: "B4 school", text: "Martí Elementary called.", hide: ["Martí Elementary"] },
  { group: "B4 school", text: "Teachers at JMES report hitting.", hide: ["JMES"] },
  { group: "B4 school", text: "The JME staff agreed.", hide: ["JME"] },
  { group: "B4 school", text: "José Martí Elementary School and Jose Marti Elementary", hide: ["José Martí", "Jose Marti"] },
  { group: "B4 school", text: "jose marti elementary school", hide: ["jose marti"] },
  // B5: the sheet's phone and IDs in ordinary variants
  { group: "B5 phone", text: "Call 555-0142 after 5.", hide: ["555-0142"] },
  { group: "B5 phone", text: "Phone (305)555-0142 or 305 555 0142 or 305.555.0142 or 3055550142.", hide: ["555-0142", "555 0142", "555.0142", "3055550142"] },
  { group: "B5 phone", text: "+1 (305) 555-0142", hide: ["555-0142"] },
  { group: "B5 id", text: "ID FL 123 - 456 - 789", hide: ["123", "456", "789"] },
  { group: "B5 id", text: "Medicaid 123456789", hide: ["123456789"] },
  { group: "B5 id", text: "Medicaid ending in 3210", hide: ["3210"] },
  { group: "B5 id", text: "Last 4 of Medicaid: 6789", hide: ["6789"] },
  { group: "B5 id", text: "Member FL-123-456-789 and fl 123456789", hide: ["123-456-789", "123456789"] },
  { group: "B5 id", text: "Policy 98765 43210", hide: ["98765 43210"] },
  // B6: names joined to other text, suffixed, or split by invisible characters
  { group: "B6 joined", text: "File MateoFicticio.pdf attached.", hide: ["Mateo", "Ficticio"] },
  { group: "B6 joined", text: "Her handle is @mateoficticio and #TeamMateo.", hide: ["mateo", "ficticio"] },
  { group: "B6 joined", text: "mateo_ficticio_cde_2026.docx", hide: ["mateo", "ficticio"] },
  { group: "B6 joined", text: "Valerias toys and Mateos tablet", hide: ["Valeria", "Mateo"] },
  { group: "B6 joined", text: "Ficticios' house", hide: ["Ficticio"] },
  { group: "B6 invisible", text: "Fic\u{200D}ticio said", hide: ["Fic\u{200D}ticio", "Ficticio"] },
  { group: "B6 invisible", text: "Lu\u{200C}cía called", hide: ["Lu\u{200C}cía", "Lucía"] },
  { group: "B6 invisible", text: "Ma\u{2060}teo ran", hide: ["Ma\u{2060}teo", "Mateo"] },
  { group: "B6 invisible", text: "Mat\u{00AD}eo and Ma\u{200B}teo and Ma\u{180E}teo", hide: ["Mateo"] },
  { group: "B6 invisible", text: "Andr\u{E9}s and Andre\u{301}s", hide: ["Andrés", "Andres"] },
  // B1: letter-spaced text, as PDFs give it
  { group: "B1 spaced", text: "L u c i a | F i c t i c i o | i s | t h e | m o t h e r", hide: ["L u c i a", "F i c t i c i o"] },
  { group: "B1 spaced", text: "Examinee | M a t | e o | F i | c t | i | c i | o", hide: ["M a t | e o", "F i | c t | i | c i | o"] },
  { group: "B1 spaced", text: "Client: Ma | teo Ficti | cio", hide: ["Ma | teo", "Ficti | cio"] },
  { group: "B1 spaced", text: "V a l e r i a  attends", hide: ["V a l e r i a"] },
  // Names on the sheet, any form
  { group: "Names", text: "MATEO FICTICIO GÓMEZ; Ficticio, Mateo; M. Ficticio; Mateo F.; M.F.", hide: ["Mateo", "Ficticio", "Gómez", "M.F."] },
  { group: "Names", text: "Fic-\nticio and Ficti-\ncio Gómez", hide: ["Fic-\nticio", "Ficti-\ncio"] },
  { group: "Names", text: "Ficticio–Gómez family; Ficticio-Gomez", hide: ["Ficticio", "Gómez", "Gomez"] },
  { group: "Names", text: "la señora Ficticio y Sra. Gómez", hide: ["Ficticio", "Gómez"] },
  { group: "Names", text: "Lucía's notes; Ficticios' car; Teo's tablet", hide: ["Lucía", "Ficticio", "Teo"] },
  { group: "Names", text: "Daniela Muestra, M.S., BCBA", hide: ["Daniela", "Muestra"] },
  { group: "Names", text: "Ms. Brown and Hope Brown; hope and brown stay", hide: ["Ms. Brown", "Hope Brown"], keep: ["hope and brown stay"] },
  { group: "Names", text: "Hope said the brown bag was his.", hide: ["Hope said"], keep: ["brown bag"] },
  // M3: diminutives
  { group: "M3 diminutives", text: "Mateíto and Mateito and Teíto", hide: ["Mateíto", "Mateito", "Teíto"] },
  { group: "M3 diminutives", text: "Valerita and Luciita", hide: ["Valerita"] },
  // H4: people not on the sheet
  { group: "H4 people", text: "Ana María Prado-Ilustre, BCBA, signed.", hide: ["Ana María", "Prado-Ilustre"] },
  { group: "H4 people", text: "Signed: Rodrigo Ejemplar, M.D.", hide: ["Rodrigo", "Ejemplar"] },
  { group: "H4 people", text: "Coach Mike and Abuela Carmen and Tía Rosario help.", hide: ["Mike", "Carmen", "Rosario"] },
  { group: "H4 people", text: "his aunt Marisol and grandma Inés visit", hide: ["Marisol", "Inés"] },
  { group: "H4 people", text: "Su primo Bruno y su prima Elisa.", hide: ["Bruno", "Elisa"] },
  { group: "H4 people", text: "Teacher: Ms. Rivera.", hide: ["Rivera"], keep: ["Teacher: Ms."] },
  { group: "H4 people", text: "Examinee: Pablo Desconocido   DOB: 01/02/2019", hide: ["Pablo", "Desconocido", "01/02/2019"] },
  { group: "H4 people", text: "Dr. Tomás Ilustre referred him.", hide: ["Tomás", "Ilustre"] },
  // H4: phones, ZIP codes, Spanish-style streets, IDs after other labels
  { group: "H4 phones", text: "tel. 555 0199", hide: ["555 0199"] },
  { group: "H4 phones", text: "cel: 786-5550199", hide: ["5550199"] },
  { group: "H4 phones", text: "786/555/0199", hide: ["786/555/0199"] },
  { group: "H4 phones", text: "Cell 786 555 0199 ext 12", hide: ["786 555 0199"] },
  { group: "H4 addresses", text: "Lives in Doral 33172.", hide: ["33172"] },
  { group: "H4 addresses", text: "22 Calle Ocho, Miami", hide: ["22 Calle Ocho", "Miami"] },
  { group: "H4 addresses", text: "Apartment 3B at 900 Brickell Avenue", hide: ["3B", "900 Brickell"] },
  { group: "H4 addresses", text: "1500 Avenida Ponce de León, San Juan, PR 00909", hide: ["1500", "Ponce", "00909"] },
  { group: "H4 addresses", text: "P.O. Box 4410", hide: ["4410"] },
  { group: "H4 ids", text: "Florida KidCare 12345", hide: ["12345"] },
  { group: "H4 ids", text: "AETNA W1234 5678", hide: ["W1234", "5678"] },
  { group: "H4 ids", text: "Sunshine Health number is SH4471-22", hide: ["SH4471-22"] },
  { group: "H4 ids", text: "medicaid id is 1 2 3 4 5 6 7 8 9", hide: ["1 2 3 4 5 6 7 8 9"] },
  { group: "H4 ids", text: "SSN 123-45-6789; MRN 00456789; NPI 1234567893", hide: ["123-45-6789", "00456789", "1234567893"] },
  // Emails and URLs
  { group: "Emails", text: "Write to lucia.ficticio@example.com or LUCIA.FICTICIO@EXAMPLE.COM", hide: ["lucia.ficticio"] },
  { group: "Emails", text: "https://example.com/mateo-ficticio/report", hide: ["mateo", "ficticio"] },
  // M4: ages with days
  { group: "M4 ages", text: "Chronological age 6-8-8 on test date 11/22/2026", hide: ["6-8-8"], keep: ["11/22/2026", "6-8"] },
  { group: "M4 ages", text: "CA: 6;8;8", hide: ["6;8;8"], keep: ["6;8"] },
  { group: "M4 ages", text: "Age 6 years, 8 months, 8 days", hide: ["8 days"], keep: ["6 years, 8 months"] },
  { group: "M4 ages", text: "Edad: 6 años, 8 meses y 8 días", hide: ["8 días"], keep: ["6 años, 8 meses"] },
  { group: "M4 ages", text: "Age at testing 4:2 stays.", hide: [], keep: ["4:2"] },
];

/** What must survive whatever the sheet: clinical terms, codes, scores. */
export const CLINICAL = [
  "Vineland-3 ABC 66 (62-70), percentile 1, age equivalent 1:6",
  "ADOS-2 Module 3, comparison score 7; SRS-2 T-score 76; CARS-2 34.5",
  "VB-MAPP Level 2; ABLLS-R; BASC-3 PRQ; CBCL; M-CHAT-R/F",
  "CPT 97151, 97153, 97155, 97156, 97157, 97158, 0362T, 0373T",
  "ICD-10 F84.0, F88, F90.2, Z13.41, R62.50",
  "Recommended 97153 RBT services 20 hours per week; 97155 supervision 4 hours.",
  "from 8:00 to 14:00, 2 to 4 times per week; Florida Statute 393.17",
  "he will need help; hope is high; a rose; mark the box; it may rain",
  "Code 97153 and Procedure 97155 and Total 33533 units",
];

/** What models do to placeholders: [what the model wrote, what must come back, whether it must be reported]. */
export const REIDENTIFY_SOURCE = "Mateo, his mother Lucía and Lucía Ficticio. DOB 03/14/2020. Andrés.";
export const REIDENTIFY_CASES: Array<[string, string, boolean]> = [
  ["[CLIENT NAME]", "[CLIENT NAME]", true],
  ["[Client's name]", "[Client's name]", true],
  ["[CLIENT FIRST NAME]", "[CLIENT FIRST NAME]", true],
  ["[CLIENT 1]", "[CLIENT 1]", true],
  ["[CLIENT FULL]", "[CLIENT FULL]", true],
  ["[CLIENT'S FULL NAME]", "[CLIENT'S FULL NAME]", true],
  ["[CAREGIVER 1 AND 2]", "[CAREGIVER 1 AND 2]", true],
  ["[DOB MONTH AND YEAR]", "[DOB MONTH AND YEAR]", true],
  ["[DOB'S]", "[DOB'S]", true],
  ["[CAREGIVER 3]", "[CAREGIVER 3]", true],
  ["[SIBLING 1]", "[SIBLING 1]", true],
  ["[MOTHER]", "[MOTHER]", true],
  ["[CLIENTE]", "[CLIENTE]", true],
  ["[CUIDADOR 1]", "[CUIDADOR 1]", true],
  ["CLIENT INFORMATION", "CLIENT INFORMATION", true],
  ["[CLIENT] and [Client] and [client]", "Mateo and Mateo and Mateo", false],
  ["[CLIENT]'s and [CLIENT’S] and [CLIENT'S]", "Mateo's and Mateo’s and Mateo's", false],
  ["[CAREGIVER_1] [CAREGIVER-1] [CAREGIVER1] [caregiver 1]", "Lucía Lucía Lucía Lucía", false],
  ["{CLIENT} <CLIENT> [[CLIENT]] \\[CLIENT\\]", "Mateo Mateo Mateo Mateo", false],
  ["(CLIENT) and (client)", "Mateo and (client)", false],
  ["[CLIENT and CAREGIVER 1]", "[CLIENT and CAREGIVER 1]", true],
  ["[CLIENT went home", "Mateo went home", false],
  ["went home CLIENT]", "went home Mateo", false],
  ["**[CLIENT]** and *[CAREGIVER 1]*", "**Mateo** and *Lucía*", false],
  ["CAREGIVER 1 FULL NAME signed", "Lucía Ficticio signed", false],
  ["[CLIENT INITIALS].", "M.F.", false],
  ["[DOB]", "03/14/2020", false],
  ["See [the notes](notes.md) [sic]", "See [the notes](notes.md) [sic]", false],
];
