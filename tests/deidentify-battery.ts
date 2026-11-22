/*
 * Invented clients for the de-identification tests. Every name, date, place, phone
 * number, email address and ID here is made up; any resemblance to a real person is
 * accidental. Each case has its client sheet, paragraphs written the way a clinician's
 * notes, a CDE, an IEP and a score report really read, the identifying strings that
 * must not survive, and the clinical words that must.
 */
import type { ClientSheet } from "../src/main/deidentify/index.ts";

export interface BatteryCase {
  name: string;
  sheet: ClientSheet;
  paragraphs: string[];
  /** Identifying strings that must not be in the de-identified text (compared ignoring case and accents). */
  mustHide: string[];
  /** Names that are also everyday words: they must not be in the text with a capital letter. */
  mustHideCapitalized?: string[];
  /** Clinical and ordinary words that must survive as written. */
  mustKeep: string[];
}

export const TODAY = new Date("2026-11-22T12:00:00Z");

export const BATTERY: BatteryCase[] = [
  {
    name: "Spanish names, accents, a family sharing the surname, a school named after a person",
    sheet: {
      client: { firstName: "Mateo", lastName: "Ficticio Gómez", nicknames: ["Teo", "Mati"], dateOfBirth: "2022-08-03" },
      caregivers: [
        { firstName: "Lucía", lastName: "Ficticio", relation: "mother" },
        { firstName: "Andrés", lastName: "Ficticio", relation: "father" },
      ],
      family: [{ firstName: "Valeria", lastName: "Ficticio Gómez", relation: "sister" }],
      professionals: [{ firstName: "Daniela", lastName: "Muestra", relation: "BCBA" }],
      schools: ["José Martí Elementary School"],
      addresses: ["4471 SW 12th Terrace, Apt 3, Miami, FL 33135"],
      phones: ["(305) 555-0142"],
      ids: ["9876543210"],
    },
    paragraphs: [
      "Examinee: Mateo Ficticio Gómez   DOB: 08/03/2022   Medicaid ID: 9876543210\nRespondent: Lucía Ficticio (mother)   Interview date: 10/02/2026",
      "Mateo vive con la madre, el padre (Andrés, trabaja de noche en un almacén) y su hermana Valeria, de 7 años. En casa se habla español; en el VPK le hablan en inglés. La mamá le dice Teo y a veces Mati. Su primo Bruno lo visita los domingos.",
      "MATEO's mother, Lucia Ficticio, reports that he bites her forearm when the tablet is removed. Mrs. Ficticio said Mateo's tantrums last 10 to 15 minutes. Mr. Andres Ficticio works nights.",
      "Per the teacher at José Martí Elementary, Mateo hits peers and leaves the classroom. The family asked whether Jose Marti Elementary School could observe him. He was born on August 3, 2022 (DOB 8/3/22).",
      "Direct observation by Daniela Muestra, M.S., BCBA, at home on 10/02/2026 and 10/09/2026: Mateo\nFicticio eloped twice. The Ficticios have door alarms. Ficticio Gómez, Mateo is not toilet trained.",
      "Home address: 4471 SW 12th Ter., Apt 3, Miami, FL 33135. Mother's cell: 305-555-0142.",
      "Vineland-3: Communication standard score 62, percentile 1; Daily Living Skills 70; ABC 66 (57-67). Recommended 97153 RBT services 20 hours per week, 97155 supervision, 97156 parent training. Diagnosis F84.0. Age at testing 4:2.",
    ],
    mustHide: [
      "Mateo", "Ficticio", "Gómez", "Teo", "Mati", "Bruno", "Lucía", "Lucia", "Andrés", "Andres", "Valeria", "Daniela", "Muestra",
      "José Martí", "Jose Marti", "08/03/2022", "August 3, 2022", "8/3/22", "9876543210", "4471", "33135", "305-555-0142",
    ],
    mustKeep: ["VPK", "97153", "97155", "97156", "F84.0", "Vineland-3", "standard score 62", "percentile 1", "4:2", "10/02/2026", "10/09/2026", "57-67", "Medicaid ID:", "M.S., BCBA"],
  },
  {
    name: "Hyphenated surname, a grandmother called Rosa, a pediatrician called Paz",
    sheet: {
      client: { firstName: "Sofía", lastName: "Inventada-Ruiz", dateOfBirth: "2017-06-21" },
      caregivers: [
        { firstName: "Carmen", lastName: "Inventada", relation: "mother" },
        { firstName: "Rosa", lastName: "Ruiz Prado", relation: "maternal grandmother" },
      ],
      family: [{ firstName: "Diego", lastName: "Inventada-Ruiz", relation: "brother" }],
      professionals: [
        { firstName: "Brian", lastName: "O'Neill-Prueba", relation: "teacher" },
        { firstName: "Paz", lastName: "Lindero", relation: "pediatrician" },
      ],
      schools: ["Ejemplo Elementary School"],
      emails: ["carmen.inventada@example.com"],
      phones: ["786-555-0177"],
    },
    paragraphs: [
      "Notes by the BCBA. Interview at home with Carmen Inventada (mother) on 10/05/2026, 90 minutes, in English. Sofía lives with her mother, her brother Diego (6) and her maternal grandmother, Rosa Ruiz, who looks after the children from 3:00 to 5:30 p.m.",
      "Sofia Inventada-Ruiz leaves the classroom 2 to 4 times per week. Her teacher, Mr. O'Neill-Prueba, wrote that Sofía threw a chair. Sofía's brother Diego had a bruise on his upper arm. Inventada-\nRuiz, Sofía attends Ejemplo Elementary (4th grade).",
      "La abuela Rosa la cuida por las tardes. Sofía lleva una camiseta rosa y quiere estar en paz. Dr. Paz Lindero, her pediatrician, prescribed methylphenidate ER 18 mg in March 2026.",
      "Contact: carmen.inventada@example.com, 786.555.0177. Sofía was born 06/21/2017; her mother's date of birth is 02/11/1988.",
      "IEP meeting held 04/17/2026 at Ejemplo Elementary School. BASC-3 PRQ: Attachment T-score 38. CPT 97151 for the assessment.",
    ],
    mustHide: [
      "Sofía", "Sofia", "Inventada", "Ruiz", "Carmen", "Diego", "O'Neill", "Prueba", "Lindero", "Ejemplo",
      "carmen.inventada@example.com", "786.555.0177", "06/21/2017", "02/11/1988",
    ],
    mustHideCapitalized: ["Rosa", "Paz"],
    mustKeep: ["camiseta rosa", "en paz", "methylphenidate ER 18 mg", "March 2026", "BASC-3 PRQ", "T-score 38", "97151", "04/17/2026", "10/05/2026", "4th grade"],
  },
  {
    name: "English names that are common words: a client called Will, a mother called Hope",
    sheet: {
      client: { firstName: "William", lastName: "Ashcombe", nicknames: ["Will", "Billy"], preferredName: "Will", dateOfBirth: "2019-01-30" },
      caregivers: [{ firstName: "Hope", lastName: "Ashcombe", relation: "mother" }],
      professionals: [{ firstName: "Grace", lastName: "Whitfield", relation: "speech therapist" }],
      schools: ["Grace Hopper Academy"],
      addresses: ["908 Pinecrest Lane, Orlando, FL 32803"],
      ids: ["A12345678"],
    },
    paragraphs: [
      "Will is a 7-year-old boy who will need support at school. His mother, Hope Ashcombe, said she has hope that Will's elopement will decrease. William Ashcombe was born January 30, 2019.",
      "Will's speech therapist, Grace Whitfield, reports he will answer yes/no questions. Ms. Whitfield works with grace and patience. Hope said Billy hits his head when he is told no.",
      "WILL ASHCOMBE\nMember ID: A12345678\nAddress: 908 Pinecrest Lane, Orlando, FL 32803",
      "Grace Hopper Academy reported 3 incidents in October. The school will provide a 1:1 aide. Ashcombe, William\nDOB 01/30/2019",
    ],
    mustHide: ["Ashcombe", "William", "Billy", "Whitfield", "Grace Hopper", "A12345678", "908 Pinecrest", "32803", "January 30, 2019", "01/30/2019"],
    mustHideCapitalized: ["Will", "Hope", "Grace"],
    mustKeep: ["will need support", "has hope", "will decrease", "will answer", "with grace and patience", "will provide", "1:1 aide", "7-year-old", "3 incidents"],
  },
  {
    name: "Two given names, two surnames with common words, a father sharing a first name",
    sheet: {
      client: { firstName: "José María", lastName: "Peña Cruz", nicknames: ["Chema"], dateOfBirth: "2020-11-09" },
      caregivers: [{ firstName: "Yolanda", lastName: "Cruz de la Fuente", relation: "mother" }],
      family: [{ firstName: "Josefina", lastName: "Peña", relation: "aunt" }],
      professionals: [{ firstName: "Esteban", lastName: "Quiñones", relation: "occupational therapist" }],
      ids: ["MRN 00456789"],
      other: ["Little Steps Therapy Center"],
    },
    paragraphs: [
      "José María Peña Cruz (Chema) es un niño de 6 años. La mamá, Yolanda Cruz de la Fuente, dice que le da pena llevarlo al parque porque se escapa. Su tía Josefina Peña lo cuida los martes. Le tiene miedo a la cruz de la pared.",
      "Chema attends OT with Esteban Quiñones at Little Steps Therapy Center (MRN 00456789). Jose Maria Pena Cruz was diagnosed on 11/15/2023. Ms. Cruz de la Fuente reports the cross on the wall scares him; she says the cruz is from his grandmother.",
      "J.M. Peña Cruz was born 11/9/20. José María's aunt Ms. Peña attended the session on 11/03/2026. QUIÑONES, ESTEBAN, OTR/L.",
    ],
    mustHide: ["José María", "Jose Maria", "Chema", "Yolanda", "Fuente", "Josefina", "Esteban", "Quiñones", "Quinones", "Little Steps", "00456789", "11/15/2023", "11/9/20"],
    mustHideCapitalized: ["Peña", "Pena", "Cruz"],
    mustKeep: ["le da pena", "la cruz", "the cruz", "6 años", "OTR/L", "11/03/2026", "los martes"],
  },
  {
    name: "Unaccented and all-caps spellings, particles, a name split across lines, many identifiers",
    sheet: {
      client: { firstName: "Ana Lucía", lastName: "Ejemplar", dateOfBirth: "2021-03-14" },
      caregivers: [{ firstName: "Marisol", lastName: "Ejemplar de la Fuente", relation: "aunt and legal guardian" }],
      schools: ["Coral Reef Montessori Academy"],
      addresses: ["17 Calle Ocho, Hialeah, FL 33010"],
      phones: ["+1 305 555 0110"],
      emails: ["marisol.ejemplar@example.net"],
      ids: ["FL-DCF 4482917"],
    },
    paragraphs: [
      "EJEMPLAR, ANA LUCIA\nDate of Birth: 03/14/2021\nCase #: FL-DCF 4482917\nGuardian: Marisol Ejemplar de la Fuente (aunt)",
      "Ana Lucia's aunt reported that Ana\nLucía bangs her head on the floor. Ms. de la Fuente has been her guardian since March 2024. Ana was born March 14, 2021 and was referred by Dr. Tomás Ilustre on 3-14-24.",
      "Ms. Ejemplar can be reached at (305) 555-0110 ext. 4 or marisol.ejemplar@example.net. Home: 17 Calle Ocho, Hialeah, FL 33010. Also 14 March 2021 appears on the CDE as the date of birth.",
      "Ana attends Coral Reef Montessori (VPK, 4 days a week). Medicaid # 5550012345. Her SSN on the intake form is 123-45-6789. Evaluated 2026-10-20.",
    ],
    mustHide: [
      "Ana Lucia", "Ana Lucía", "Ejemplar", "Marisol", "Fuente", "Tomás Ilustre", "Ilustre", "03/14/2021", "March 14, 2021", "14 March 2021", "3-14-24",
      "4482917", "305) 555-0110", "marisol.ejemplar@example.net", "17 Calle Ocho", "33010", "Coral Reef", "5550012345", "123-45-6789",
    ],
    mustKeep: ["bangs her head", "VPK, 4 days a week", "2026-10-20", "March 2024"],
  },
];
