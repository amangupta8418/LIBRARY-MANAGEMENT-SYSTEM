#include <stdio.h>
#include <string.h>

#define MAX 50

typedef struct {
    char entries[MAX][150];
    int top;
} LIFOStack;

void initStack(LIFOStack *s) {
    s->top = -1;
}

void push(LIFOStack *s, char *logEntry) {
    if (s->top < MAX - 1) {
        strcpy(s->entries[++s->top], logEntry);
    }
}

int main(int argc, char *argv[]) {
    LIFOStack s;
    initStack(&s);
    for (int i = 1; i < argc; i++) {
        push(&s, argv[i]);
    }
    printf("[");
    for (int i = s.top; i >= 0; i--) {
        printf("\"%s\"%s", s.entries[i], (i == 0) ? "" : ",");
    }
    printf("]\n");
    return 0;
}