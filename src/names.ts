const frenchNames = [
    "Thomas", "Lucas", "Léo", "Gabriel", "Louis", "Arthur", "Nathan", "Hugo", "Enzo", "Jules",
    "Adam", "Maël", "Liam", "Noah", "Ethan", "Mathis", "Gabin", "Sacha", "Paul", "Mohamed",
    "Emma", "Jade", "Louise", "Alice", "Chloé", "Lina", "Rose", "Léa", "Anna", "Mila",
    "Mia", "Inès", "Ambre", "Julia", "Lou", "Zoé", "Manon", "Juliette", "Agathe", "Victoire",
    "Bastien", "Damien", "Emile", "Fabrice", "Laurent", "Michel", "Pascal", "Remy", "Serge", "Thierry"
];

const germanNames = [
    "Leon", "Luis", "Jonas", "Elias", "Felix", "Finn", "Noah", "Paul", "Ben", "Luca",
    "Maximilian", "Henry", "Liam", "Oskar", "Emil", "Anton", "Theo", "Jakob", "Moritz", "David",
    "Mia", "Emma", "Sofia", "Hannah", "Emilia", "Anna", "Marie", "Mila", "Lea", "Lina",
    "Leni", "Sophie", "Clara", "Ella", "Mathilda", "Emily", "Frieda", "Maria", "Ida", "Luisa",
    "Alfons", "Boris", "Dirk", "Egon", "Fritz", "Gunter", "Horst", "Jochen", "Kurt", "Ludwig"
];

const italianNames = [
    "Leonardo", "Francesco", "Alessandro", "Lorenzo", "Mattia", "Tommaso", "Gabriele", "Riccardo", "Andrea", "Edoardo",
    "Matteo", "Giuseppe", "Nicolo", "Antonio", "Federico", "Diego", "Davide", "Christian", "Giovanni", "Pietro",
    "Sofia", "Giulia", "Aurora", "Alice", "Ginevra", "Emma", "Giorgia", "Greta", "Beatrice", "Anna",
    "Martina", "Ludovica", "Chiara", "Matilde", "Laura", "Vittoria", "Gaia", "Francesca", "Camilla", "Noemi",
    "Alberto", "Biagio", "Cosimo", "Dario", "Ettore", "Flavio", "Giorgio", "Iacopo", "Raffaele", "Stefano"
];

const allNames = [...frenchNames, ...germanNames, ...italianNames];

export function generatePilotName(): string {
    const picked: string[] = [];
    const tempNames = [...allNames];

    for (let i = 0; i < 3; i++) {
        const index = Math.floor(Math.random() * tempNames.length);
        picked.push(tempNames[index]);
        // Remove to avoid duplicates in the same name if possible, 
        // although with this many names it's unlikely anyway.
        tempNames.splice(index, 1);
    }

    return picked.join("-");
}
