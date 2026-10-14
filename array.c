#include <stdio.h>

int main() {
    const char *categories[5] = {"CS", "Systems", "Database", "Networking", "Software Engg"};
    printf("[");
    for (int i = 0; i < 5; i++) {
        printf("\"%s\"%s", categories[i], (i == 4) ? "" : ",");
    }
    printf("]\n");
    return 0;
}