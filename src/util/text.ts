/**
 * Concordanza di numero nei testi del rapporto: "1 sessione", "3 sessioni". Da usare ogni volta che un numero
 * precede un sostantivo o un aggettivo variabile.
 */
export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Numero con il sostantivo (ed eventuali aggettivi) concordato: nWords(1, 'categoria attiva', 'categorie attive'). */
export const nWords = (n: number, one: string, many: string): string => `${n} ${plural(n, one, many)}`;

/**
 * "Etichetta: elenco", senza lasciare un elenco vuoto dopo i due punti: se l'elenco è vuoto si usa il testo alternativo
 * (o la sola etichetta).
 */
export const labelled = (label: string, list: string, empty?: string): string => (list.trim() ? `${label}: ${list}` : (empty ?? label));
