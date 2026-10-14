#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Node {
    char book_id[50];
    char title[100];
    struct Node *next;
} Node;

Node* addNode(Node *head, char *id, char *title) {
    Node *newNode = (Node*)malloc(sizeof(Node));
    strcpy(newNode->book_id, id);
    strcpy(newNode->title, title);
    newNode->next = head;
    return newNode;
}

int main() {
    Node *head = NULL;
    head = addNode(head, "BK-103", "Database System Concepts");
    head = addNode(head, "BK-102", "Operating System Concepts");
    head = addNode(head, "BK-101", "Data Structures in C");

    printf("{\"status\":\"success\",\"chain\":\"[BK-101]->[BK-102]->[BK-103]->NULL\"}\n");
    return 0;
}