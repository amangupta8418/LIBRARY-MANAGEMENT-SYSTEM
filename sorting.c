#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char book_id[50];
    char title[100];
    char author[100];
    char category[50];
    int available_copies;
} Book;

int compareBooks(const void *a, const void *b) {
    Book *b1 = (Book*)a;
    Book *b2 = (Book*)b;
    return strcmp(b1->title, b2->title);
}

int main() {
    Book catalog[3] = {
        {"BK-102", "Operating System Concepts", "Silberschatz", "Systems", 0},
        {"BK-101", "Data Structures and Algorithms in C", "Narasimha Karumanchi", "CS", 2},
        {"BK-103", "Database System Concepts", "Korth", "Database", 3}
    };

    qsort(catalog, 3, sizeof(Book), compareBooks);

    printf("[");
    for (int i = 0; i < 3; i++) {
        printf("{\"book_id\":\"%s\",\"title\":\"%s\",\"author\":\"%s\",\"category\":\"%s\",\"available_copies\":%d}%s",
               catalog[i].book_id, catalog[i].title, catalog[i].author, catalog[i].category, catalog[i].available_copies, (i == 2) ? "" : ",");
    }
    printf("]\n");
    return 0;
}